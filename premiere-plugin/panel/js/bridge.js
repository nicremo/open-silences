/**
 * Open Silences agent bridge, CEP side.
 *
 * Polls the bridge directory, claims one command at a time by renaming it,
 * evaluates the matching host script and answers with the raw host text.
 * fs, path and evalScript are injected so the server runs under node:test.
 */
import {hostScriptFor} from './core.js';
import {PROTOCOL_VERSION, HEARTBEAT_INTERVAL_MS, COMMAND_PATTERN, responseFile, validateCommand} from './bridge-protocol.js';

export function createBridgeServer({fs, path, directory, evalScript, now = () => Date.now()}) {
  let busy = false;
  const write = (name, value) => {
    const target = path.join(directory, name);
    const part = `${target}.part`;
    fs.writeFileSync(part, JSON.stringify(value), {mode:0o600});
    // rename() inside one directory is atomic, readers never see half a file.
    fs.renameSync(part, target);
  };
  const heartbeat = () => write('heartbeat.json', {protocol:PROTOCOL_VERSION, t:now(), busy});
  async function tick() {
    if (busy) return 0;
    const next = fs.readdirSync(directory).filter(name => COMMAND_PATTERN.test(name)).sort()[0];
    if (!next) return 0;
    busy = true;
    try {
      const id = next.match(COMMAND_PATTERN)[1];
      const claimed = path.join(directory, `${next}.claimed`);
      try { fs.renameSync(path.join(directory, next), claimed); } catch (_) { return 0; }
      let value = null;
      try { value = JSON.parse(fs.readFileSync(claimed, 'utf8')); } catch (_) {}
      const checked = validateCommand(value, now());
      let answer;
      if (!checked.ok) answer = {ok:false, error:checked.error};
      else if (checked.command.id !== id) answer = {ok:false, error:'The command id does not match its file name.'};
      else {
        try { answer = {ok:true, reply:await evalScript(hostScriptFor(checked.command.name, checked.command.payload))}; }
        catch (error) { answer = {ok:false, error:error.message}; }
      }
      write(responseFile(id), {protocol:PROTOCOL_VERSION, id, ...answer, finishedAt:now()});
      fs.unlinkSync(claimed);
      return 1;
    } finally { busy = false; }
  }
  return {tick, heartbeat, isBusy:() => busy};
}

export function startBridge({fs, path, directory, evalScript, now, pollMs = 250, log = () => {}}) {
  fs.mkdirSync(directory, {recursive:true, mode:0o700});
  fs.chmodSync(directory, 0o700);
  const server = createBridgeServer({fs, path, directory, evalScript, now});
  let stopped = false, timer = null;
  const beat = () => { try { server.heartbeat(); } catch (error) { log(error); } };
  beat();
  const heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  const loop = async () => {
    if (stopped) return;
    try { await server.tick(); } catch (error) { log(error); }
    timer = setTimeout(loop, pollMs);
  };
  loop();
  return {stop() { stopped = true; clearInterval(heartbeatTimer); clearTimeout(timer); }};
}
