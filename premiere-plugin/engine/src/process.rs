//! Child process handling for the decoder and probe helpers.
//!
//! Guarantees:
//! * no shell is involved, arguments are passed as a vector,
//! * stdout and stderr are drained in parallel, so a chatty child cannot block
//!   on a full pipe,
//! * stderr is kept as a bounded ring buffer of the LAST bytes (a real tail),
//! * the caller never performs an unbounded join: the pipe readers report
//!   through a channel and the caller waits with a timeout,
//! * every call has a timeout and a cancel token, both checked while reading and
//!   while waiting,
//! * waiting uses `try_wait` with short lock sections, so the watchdog can
//!   always acquire the child handle,
//! * termination is hard: the process group gets SIGTERM, then SIGKILL after a
//!   short grace period, and the death of the group is verified. A descendant
//!   that ignores SIGTERM cannot keep the pipes open forever,
//! * the termination cause (timeout, cancel, normal exit) is recorded
//!   atomically and is authoritative, even when the process exits right at the
//!   deadline,
//! * the child is killed and reaped on drop, on any error path and on panic.

use std::io::Read;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// Grace period between SIGTERM and SIGKILL for a process group.
const TERMINATION_GRACE: Duration = Duration::from_millis(300);
/// Bounded wait for the pipe readers after a termination.
const READER_GRACE: Duration = Duration::from_millis(500);

const CAUSE_NONE: u8 = 0;
const CAUSE_TIMEOUT: u8 = 1;
const CAUSE_CANCEL: u8 = 2;
/// A read or callback failure ended the child. Kept apart from timeout and
/// cancel so the original error is never relabelled.
const CAUSE_ERROR: u8 = 3;

/// Cooperative cancellation, shared between the caller and the child handling.
#[derive(Clone, Default)]
pub struct CancelToken {
    flag: Arc<AtomicBool>,
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
}

/// Bounded capture of the child stderr. Keeps the last `limit` bytes.
#[derive(Debug, Clone, Default)]
pub struct StderrCapture {
    pub tail: String,
    pub total_bytes: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Output {
    pub success: bool,
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: StderrCapture,
    pub timed_out: bool,
    pub cancelled: bool,
    pub duration: Duration,
}

struct Shared {
    child: Mutex<Option<Child>>,
    /// Prevents a second termination attempt from `Drop`.
    finished: AtomicBool,
    cause: AtomicU8,
    stderr: Mutex<StderrCapture>,
}

impl Shared {
    fn set_cause(&self, cause: u8) {
        let _ = self
            .cause
            .compare_exchange(CAUSE_NONE, cause, Ordering::SeqCst, Ordering::SeqCst);
    }

    fn cause(&self) -> u8 {
        self.cause.load(Ordering::SeqCst)
    }
}

/// Kills the child together with its process group, first politely, then hard.
///
/// Unix: the child is spawned as its own process group leader, so a negative pid
/// targets exactly that group, including grandchildren that ignore SIGTERM.
/// Windows: `taskkill /T /F` ends the process tree.
pub fn terminate(child: &mut Child) {
    let pid = child.id();
    #[cfg(unix)]
    {
        kill_group(pid, "-TERM");
        let deadline = Instant::now() + TERMINATION_GRACE;
        while Instant::now() < deadline {
            if !group_alive(pid) {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        if group_alive(pid) {
            kill_group(pid, "-KILL");
        }
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(unix)]
fn kill_group(pid: u32, signal: &str) {
    // Separate options from the negative process-group operand on Unix.
    let _ = Command::new("/bin/kill")
        .arg(signal)
        .arg("--")
        .arg(format!("-{pid}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// True while any process of the group is still alive.
#[cfg(unix)]
fn group_alive(pid: u32) -> bool {
    Command::new("/bin/kill")
        .arg("-0")
        .arg("--")
        .arg(format!("-{pid}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

struct Spawned {
    shared: Arc<Shared>,
}

fn spawn(program: &str, args: &[String]) -> Result<Spawned, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Own process group: a single negative pid kill reaches the child and
        // every process it started.
        command.process_group(0);
    }
    let child = command
        .spawn()
        .map_err(|error| format!("cannot start {program}: {error}"))?;

    Ok(Spawned {
        shared: Arc::new(Shared {
            child: Mutex::new(Some(child)),
            finished: AtomicBool::new(false),
            cause: AtomicU8::new(CAUSE_NONE),
            stderr: Mutex::new(StderrCapture::default()),
        }),
    })
}

impl Drop for Spawned {
    fn drop(&mut self) {
        if self.shared.finished.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut slot = self
            .shared
            .child
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(child) = slot.as_mut() {
            terminate(child);
        }
    }
}

fn spawn_deadline_watchdog(
    shared: Arc<Shared>,
    deadline: Instant,
    cancel: CancelToken,
) -> mpsc::Sender<()> {
    let (sender, receiver) = mpsc::channel::<()>();
    thread::spawn(move || loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let step = remaining.min(Duration::from_millis(20));
        match receiver.recv_timeout(step.max(Duration::from_millis(1))) {
            Ok(()) | Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {}
        }
        let cause = if cancel.is_cancelled() {
            CAUSE_CANCEL
        } else if Instant::now() >= deadline {
            CAUSE_TIMEOUT
        } else {
            continue;
        };
        shared.set_cause(cause);
        let mut slot = shared
            .child
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(child) = slot.as_mut() {
            terminate(child);
        }
        return;
    });
    sender
}

/// Drains stderr into the shared ring buffer and signals completion through a
/// channel, so the caller never has to join the thread unconditionally.
fn spawn_stderr_drain(
    mut stderr: impl Read + Send + 'static,
    limit: usize,
    shared: Arc<Shared>,
) -> (mpsc::Receiver<()>, thread::JoinHandle<()>) {
    let (sender, receiver) = mpsc::channel::<()>();
    let handle = thread::spawn(move || {
        let mut ring: Vec<u8> = Vec::with_capacity(limit.min(1 << 16));
        let mut buffer = [0u8; 8192];
        loop {
            match stderr.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    let mut capture = shared
                        .stderr
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    capture.total_bytes += read;
                    ring.extend_from_slice(&buffer[..read]);
                    if ring.len() > limit {
                        let excess = ring.len() - limit;
                        ring.drain(..excess);
                        capture.truncated = true;
                    }
                    capture.tail = String::from_utf8_lossy(&ring).to_string();
                }
                Err(_) => break,
            }
        }
        let _ = sender.send(());
    });
    (receiver, handle)
}

/// Records a cause and terminates the child right away instead of waiting for
/// the deadline. Used on read and callback failures.
fn terminate_now(shared: &Arc<Shared>, cause: u8) {
    shared.set_cause(cause);
    let mut slot = shared
        .child
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if let Some(child) = slot.as_mut() {
        terminate(child);
    }
}

fn take_pipe<T>(
    shared: &Arc<Shared>,
    take: impl FnOnce(&mut Child) -> Option<T>,
) -> Result<T, String> {
    let mut slot = shared
        .child
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let child = slot.as_mut().ok_or("child disappeared")?;
    take(child).ok_or_else(|| "child pipe unavailable".to_string())
}

struct Termination {
    status: Option<ExitStatus>,
    timed_out: bool,
    cancelled: bool,
    failed: bool,
}

/// Waits for the child with short lock sections and a deadline.
///
/// The recorded cause is authoritative: if the process exits because of a
/// timeout or a cancellation, it is reported as such even though `try_wait` also
/// returns a status.
fn wait_with_deadline(
    shared: &Arc<Shared>,
    deadline: Instant,
    cancel: &CancelToken,
) -> Termination {
    loop {
        let exited = {
            let mut slot = shared
                .child
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            match slot.as_mut() {
                None => Some(None),
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => Some(Some(status)),
                    Ok(None) => None,
                    Err(_) => Some(None),
                },
            }
        };
        if let Some(status) = exited {
            let cause = shared.cause();
            return Termination {
                status,
                timed_out: cause == CAUSE_TIMEOUT,
                cancelled: cause == CAUSE_CANCEL,
                failed: cause == CAUSE_ERROR,
            };
        }

        let cause = if cancel.is_cancelled() {
            Some(CAUSE_CANCEL)
        } else if Instant::now() >= deadline {
            Some(CAUSE_TIMEOUT)
        } else {
            None
        };
        if let Some(cause) = cause {
            shared.set_cause(cause);
            let mut slot = shared
                .child
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if let Some(child) = slot.as_mut() {
                terminate(child);
            }
        }
        thread::sleep(Duration::from_millis(5));
    }
}

fn finish(
    spawned: Spawned,
    watchdog: mpsc::Sender<()>,
    stderr_receiver: mpsc::Receiver<()>,
    deadline: Instant,
    cancel: &CancelToken,
) -> (Termination, StderrCapture) {
    let termination = wait_with_deadline(&spawned.shared, deadline, cancel);
    spawned.shared.finished.store(true, Ordering::SeqCst);
    let _ = watchdog.send(());
    // Bounded wait: a stuck reader must not block the result.
    let _ = stderr_receiver.recv_timeout(READER_GRACE);
    let stderr = spawned
        .shared
        .stderr
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    (termination, stderr)
}

/// Runs a child to completion, draining both pipes in parallel.
pub fn run(
    program: &str,
    args: &[String],
    timeout: Duration,
    stdout_limit: usize,
    stderr_limit: usize,
    cancel: &CancelToken,
) -> Result<Output, String> {
    run_with(
        program,
        args,
        timeout,
        stdout_limit,
        stderr_limit,
        cancel,
        |_| Ok(()),
    )
}

#[allow(clippy::too_many_arguments)]
fn run_with<F>(
    program: &str,
    args: &[String],
    timeout: Duration,
    stdout_limit: usize,
    stderr_limit: usize,
    cancel: &CancelToken,
    mut on_stdout: F,
) -> Result<Output, String>
where
    F: FnMut(&[u8]) -> Result<(), String>,
{
    let started = Instant::now();
    let deadline = started + timeout;
    let spawned = spawn(program, args)?;
    let mut reader = take_pipe(&spawned.shared, |child| child.stdout.take())?;
    let stderr = take_pipe(&spawned.shared, |child| child.stderr.take())?;
    let watchdog = spawn_deadline_watchdog(Arc::clone(&spawned.shared), deadline, cancel.clone());
    let (stderr_receiver, _stderr_thread) =
        spawn_stderr_drain(stderr, stderr_limit, Arc::clone(&spawned.shared));

    let mut collected: Vec<u8> = Vec::new();
    let mut buffer = [0u8; 8192];
    let mut read_error: Option<String> = None;
    let mut callback_error: Option<String> = None;
    loop {
        if cancel.is_cancelled() {
            terminate_now(&spawned.shared, CAUSE_CANCEL);
            break;
        }
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                if collected.len() < stdout_limit {
                    let remaining = stdout_limit - collected.len();
                    collected.extend_from_slice(&buffer[..read.min(remaining)]);
                }
                if let Err(error) = on_stdout(&buffer[..read]) {
                    callback_error = Some(error);
                    terminate_now(&spawned.shared, CAUSE_ERROR);
                    break;
                }
            }
            Err(error) => {
                read_error = Some(format!("cannot read {program} stdout: {error}"));
                terminate_now(&spawned.shared, CAUSE_ERROR);
                break;
            }
        }
    }

    let (termination, stderr_capture) =
        finish(spawned, watchdog, stderr_receiver, deadline, cancel);

    if let Some(error) = read_error {
        return Err(error);
    }
    if let Some(error) = callback_error {
        return Err(error);
    }
    if termination.failed {
        return Err(format!(
            "{program} aborted after a read failure: {}",
            stderr_capture.tail.trim()
        ));
    }
    if termination.cancelled {
        return Err(format!("{program} cancelled"));
    }
    if termination.timed_out {
        return Err(format!(
            "{program} timed out after {} s: {}",
            timeout.as_secs(),
            stderr_capture.tail.trim()
        ));
    }

    Ok(Output {
        success: termination
            .status
            .map(|code| code.success())
            .unwrap_or(false),
        status: termination.status.and_then(|code| code.code()),
        stdout: String::from_utf8_lossy(&collected).to_string(),
        stderr: stderr_capture,
        timed_out: false,
        cancelled: false,
        duration: started.elapsed(),
    })
}

/// Streams stdout into a callback while stderr is drained in parallel.
///
/// The callback receives raw chunks; returning `Err` aborts the child at once.
pub fn run_streaming<F>(
    program: &str,
    args: &[String],
    timeout: Duration,
    stderr_limit: usize,
    cancel: &CancelToken,
    mut on_stdout: F,
) -> Result<StderrCapture, String>
where
    F: FnMut(&[u8]) -> Result<(), String>,
{
    let deadline = Instant::now() + timeout;
    let spawned = spawn(program, args)?;
    let mut reader = take_pipe(&spawned.shared, |child| child.stdout.take())?;
    let stderr = take_pipe(&spawned.shared, |child| child.stderr.take())?;
    let watchdog = spawn_deadline_watchdog(Arc::clone(&spawned.shared), deadline, cancel.clone());
    let (stderr_receiver, _stderr_thread) =
        spawn_stderr_drain(stderr, stderr_limit, Arc::clone(&spawned.shared));

    let mut buffer = vec![0u8; 1 << 16];
    let mut failure: Option<String> = None;
    loop {
        if cancel.is_cancelled() {
            failure = Some(format!("{program} cancelled"));
            terminate_now(&spawned.shared, CAUSE_CANCEL);
            break;
        }
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                if let Err(error) = on_stdout(&buffer[..read]) {
                    failure = Some(error);
                    terminate_now(&spawned.shared, CAUSE_ERROR);
                    break;
                }
            }
            Err(error) => {
                failure = Some(format!("cannot read {program} stdout: {error}"));
                terminate_now(&spawned.shared, CAUSE_ERROR);
                break;
            }
        }
    }

    let (termination, stderr_capture) =
        finish(spawned, watchdog, stderr_receiver, deadline, cancel);

    if termination.cancelled
        || failure.as_deref().map(|error| error.contains("cancelled")) == Some(true)
    {
        return Err(format!("{program} cancelled"));
    }
    if let Some(error) = failure {
        return Err(error);
    }
    if termination.timed_out {
        return Err(format!(
            "{program} timed out after {} s: {}",
            timeout.as_secs(),
            stderr_capture.tail.trim()
        ));
    }
    if !termination
        .status
        .map(|code| code.success())
        .unwrap_or(false)
    {
        return Err(format!(
            "{program} failed (status {:?}): {}",
            termination.status.and_then(|code| code.code()),
            stderr_capture.tail.trim()
        ));
    }
    Ok(stderr_capture)
}

/// Watches standard input and cancels the token when the parent closes the pipe.
///
/// This is how the panel asks for a clean stop: it ends the child stdin, the
/// engine kills the decoder and exits, and nothing is left running.
pub fn watch_stdin(token: CancelToken) {
    thread::spawn(move || {
        let mut buffer = [0u8; 256];
        let mut stdin = std::io::stdin();
        loop {
            match stdin.read(&mut buffer) {
                Ok(0) => {
                    token.cancel();
                    return;
                }
                Ok(_) => continue,
                Err(_) => {
                    token.cancel();
                    return;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn pid_alive(pid: i32) -> bool {
        Command::new("/bin/kill")
            .arg("-0")
            .arg(pid.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    #[test]
    fn captures_stdout_and_stderr() {
        let output = run(
            "/bin/sh",
            &args(&["-c", "echo out; echo err 1>&2"]),
            Duration::from_secs(10),
            4096,
            4096,
            &CancelToken::new(),
        )
        .unwrap();
        assert!(output.success);
        assert_eq!(output.stdout.trim(), "out");
        assert_eq!(output.stderr.tail.trim(), "err");
        assert!(!output.timed_out);
    }

    /// Regression: a child that floods stderr must not deadlock the reader.
    #[test]
    fn does_not_deadlock_on_flooding_stderr() {
        let started = Instant::now();
        let output = run(
            "/bin/sh",
            &args(&[
                "-c",
                "i=0; while [ $i -lt 200000 ]; do echo 'diagnostic line with some length to fill the pipe buffer' 1>&2; i=$((i+1)); done; echo done",
            ]),
            Duration::from_secs(60),
            4096,
            4096,
            &CancelToken::new(),
        )
        .unwrap();
        assert!(output.success, "child failed: {:?}", output.stderr.tail);
        assert_eq!(output.stdout.trim(), "done");
        assert!(output.stderr.total_bytes > 1_000_000, "stderr not drained");
        assert!(output.stderr.truncated);
        assert!(output.stderr.tail.len() <= 4096);
        assert!(started.elapsed() < Duration::from_secs(30));
    }

    /// Regression: the stderr contract is a real tail, not the head.
    #[test]
    fn stderr_capture_keeps_the_last_bytes() {
        // The child writes 30 bytes to stderr; a limit of 24 forces truncation.
        let output = run(
            "/bin/sh",
            &args(&[
                "-c",
                "echo first; echo second 1>&2; echo last-line-is-important 1>&2",
            ]),
            Duration::from_secs(10),
            4096,
            24,
            &CancelToken::new(),
        )
        .unwrap();
        assert!(
            output.stderr.truncated,
            "30 bytes into a 24 byte ring must truncate"
        );
        assert!(
            output.stderr.tail.contains("important"),
            "tail lost the last bytes: {:?}",
            output.stderr.tail
        );
        assert!(!output.stderr.tail.contains("first"));
        assert!(!output.stderr.tail.contains("second"));
        assert!(output.stderr.total_bytes >= 30);
    }

    #[test]
    fn kills_child_on_timeout() {
        let started = Instant::now();
        let error = run(
            "/bin/sh",
            &args(&["-c", "sleep 30"]),
            Duration::from_millis(300),
            4096,
            4096,
            &CancelToken::new(),
        )
        .unwrap_err();
        assert!(error.contains("timed out"), "unexpected error: {error}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "child was not killed"
        );
    }

    /// Regression: a child that closes stdout and stderr and then hangs must not
    /// block the wait path. The watchdog needs the child handle, so waiting must
    /// use short lock sections.
    #[test]
    fn returns_in_time_when_child_closes_pipes_and_hangs() {
        let started = Instant::now();
        let error = run(
            "/bin/sh",
            &args(&["-c", "exec 1>&- 2>&-; sleep 30"]),
            Duration::from_millis(400),
            4096,
            4096,
            &CancelToken::new(),
        )
        .unwrap_err();
        assert!(error.contains("timed out"), "unexpected error: {error}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "wait path blocked for {:?}",
            started.elapsed()
        );
    }

    /// Regression: a descendant that ignores SIGTERM must be killed hard, and
    /// both processes must really be gone afterwards.
    #[test]
    fn term_ignoring_descendants_are_killed_hard() {
        let collected = Arc::new(Mutex::new(String::new()));
        let sink = Arc::clone(&collected);
        let started = Instant::now();
        let result = run_streaming(
            "/bin/sh",
            &args(&["-c", "trap '' TERM; sleep 30 & echo \"$$ $!\"; wait"]),
            Duration::from_millis(500),
            4096,
            &CancelToken::new(),
            move |chunk| {
                sink.lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .push_str(&String::from_utf8_lossy(chunk));
                Ok(())
            },
        );
        assert!(result.is_err(), "hanging child must not report success");
        let elapsed = started.elapsed();
        let text = collected
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        let mut parts = text.split_whitespace();
        let shell_pid: i32 = parts.next().expect("shell pid").parse().expect("shell pid");
        let sleep_pid: i32 = parts.next().expect("sleep pid").parse().expect("sleep pid");
        thread::sleep(Duration::from_millis(200));
        assert!(!pid_alive(shell_pid), "shell {shell_pid} is still alive");
        assert!(
            !pid_alive(sleep_pid),
            "descendant {sleep_pid} is still alive"
        );
        assert!(
            elapsed < Duration::from_secs(5),
            "termination took {elapsed:?}"
        );
    }

    /// Regression: the recorded cause is authoritative even when the process
    /// exits because of the kill. Without it, a killed child could look like a
    /// normal exit.
    #[test]
    fn timeout_is_reported_even_though_the_process_exits() {
        let error = run(
            "/bin/sh",
            &args(&["-c", "sleep 30"]),
            Duration::from_millis(250),
            4096,
            4096,
            &CancelToken::new(),
        )
        .unwrap_err();
        assert!(error.contains("timed out"), "cause lost: {error}");
    }

    #[test]
    fn cancel_token_stops_the_child() {
        let token = CancelToken::new();
        let trigger = token.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(200));
            trigger.cancel();
        });
        let started = Instant::now();
        let result = run_streaming(
            "/bin/sh",
            &args(&["-c", "while true; do echo data; done"]),
            Duration::from_secs(30),
            1024,
            &token,
            |_chunk| Ok(()),
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("cancelled"));
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "cancel was not honoured"
        );
    }

    #[test]
    fn aborts_streaming_on_callback_error() {
        let started = Instant::now();
        let result = run_streaming(
            "/bin/sh",
            &args(&["-c", "while true; do echo data; done"]),
            Duration::from_secs(60),
            1024,
            &CancelToken::new(),
            |_chunk| Err("callback stop".to_string()),
        );
        assert!(result.is_err());
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "child was not killed"
        );
    }

    #[test]
    fn reports_missing_program() {
        let error = run(
            "definitely-not-a-program",
            &[],
            Duration::from_secs(1),
            16,
            16,
            &CancelToken::new(),
        )
        .unwrap_err();
        assert!(error.contains("cannot start"));
    }
}
