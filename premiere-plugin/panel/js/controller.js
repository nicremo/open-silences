/**
 * Open Silences: panel state machine.
 *
 * Everything here is host independent and injected:
 * * `host` provides the named calls (read, readSequence, clone, apply,
 *   readItemsOfSequence) and returns `{ ok, parsed, raw }`,
 * * `engine` runs the Rust engine and returns `{ ok, envelope, runDirectory }`,
 * * `ui` renders and logs,
 * * `input` reads the current form values.
 *
 * Single flight: an action sets the busy flag before its first `await` and
 * clears it in a top level `finally`, so a double click cannot start two engine
 * processes or two clones.
 */
import {
  applyWorkflow,
  assessCapabilities,
  buildSnapshot,
  describeRejection,
  summarizePlan,
  validatePlan
} from './core.js';

export function createController({ host, engine, ui, input }) {
  const state = {
    sequence: null,
    capabilities: null,
    plan: null,
    analyzed: null,
    generation: 0,
    running: false
  };

  const canApply = () => Boolean(state.plan && state.plan.intervals.length > 0 && state.capabilities && state.capabilities.canCut);
  const setBusy = (text, running) => {
    state.running = running;
    ui.setBusy(text || '', running, canApply());
  };
  const invalidate = reason => {
    if (state.plan) {
      state.plan = null;
      ui.setSummary('Cut plan discarded.');
      ui.log(`Cut plan discarded: ${reason}`, 'muted');
    }
    state.analyzed = null;
    state.generation += 1;
    ui.setBusy('', state.running, canApply());
  };

  async function readSequence() {
    if (state.running) {
      return;
    }
    invalidate('Reading the sequence again');
    state.sequence = null;
    state.capabilities = null;
    setBusy('Reading sequence ...', true);
    try {
      const result = await host.readSequence();
      if (!result.ok) {
        ui.log(result.error, 'error');
        return;
      }
      state.sequence = result.parsed;
      state.capabilities = assessCapabilities(result.parsed);
      ui.renderSequence(result.parsed);
      ui.renderCapabilities(state.capabilities);
      ui.log(`Sequence read: ${result.parsed.tracks.length} tracks, ${result.parsed.clipCount} clips.`);
    } finally {
      setBusy('', false);
    }
  }

  async function analyze() {
    if (state.running || !state.sequence) {
      if (!state.sequence) {
        ui.log('Please read the sequence first.', 'warn');
      }
      return;
    }
    // Busy before the first await: one flight at a time.
    setBusy('Analysing ...', true);
    const generation = ++state.generation;
    state.plan = null;
    state.analyzed = null;
    try {
      const selection = input.analysisTracks();
      if (selection.length === 0) {
        ui.log('Please choose at least one audio track for the analysis.', 'warn');
        return;
      }

      // The plan must be built from the state that is current now, not from an
      // earlier read: a stale readback would bind the plan to the wrong state.
      const sequenceNow = await host.readSequence();
      if (!sequenceNow.ok) {
        ui.log(sequenceNow.error, 'error');
        return;
      }
      if (state.sequence && sequenceNow.parsed.identity !== state.sequence.identity) {
        ui.log('The active sequence is no longer the one that was read, please read it again.', 'warn');
        return;
      }
      const stateFingerprint = sequenceNow.raw;
      state.sequence = sequenceNow.parsed;
      state.capabilities = assessCapabilities(sequenceNow.parsed);
      ui.renderCapabilities(state.capabilities);

      const originalNow = await host.readItems();
      if (!originalNow.ok) {
        ui.log(originalNow.error, 'error');
        return;
      }
      if (originalNow.parsed.identity !== sequenceNow.parsed.identity) {
        ui.log('The positions do not match the sequence that was read, please read it again.', 'warn');
        return;
      }
      const itemFingerprint = originalNow.raw;

      let renderedMixdown = null;
      if (state.capabilities.nativeTimeline) {
        setBusy('Premiere renders the chosen audio tracks. This step cannot be cancelled.', true);
        const rendered = await host.call('renderAudio', {
          expectedIdentity: sequenceNow.parsed.identity,
          expectedItemFingerprint: itemFingerprint,
          expectedStateFingerprint: stateFingerprint,
          analysisTracks: selection,
          outputPath: engine.renderPath()
        });
        if (!rendered.ok) { ui.log(rendered.error, 'error'); return; }
        if (generation !== state.generation) return;
        renderedMixdown = {mediaPath: rendered.parsed.mediaPath, analysisTracks: selection};
        ui.log(`Timeline audio exported: ${(rendered.parsed.renderMilliseconds / 1000).toFixed(2)} s.`, 'ok');
        setBusy('Analysing silence ...', true);
      }

      let snapshot;
      try {
        snapshot = buildSnapshot(
          {...input.snapshot({
            sequence: sequenceNow.parsed,
            analysisTracks: selection,
            tracks: input.tracksWithRoles(sequenceNow.parsed.tracks)
          }), renderedMixdown}
        );
      } catch (error) {
        ui.log(`Snapshot not possible: ${error.message}`, 'error');
        return;
      }

      const result = await engine.run(snapshot);
      if (generation !== state.generation) {
        ui.log('A newer run replaced this one, result discarded.', 'warn');
        return;
      }
      if (!result.ok) {
        ui.log(result.error, 'error');
        return;
      }
      const plan = result.envelope.plan;
      const planProblems = validatePlan(plan);
      if (planProblems.length > 0) {
        for (const problem of planProblems) {
          ui.log(problem, 'error');
        }
        return;
      }

      state.plan = plan;
      state.analyzed = {
        identity: sequenceNow.parsed.identity,
        itemFingerprint,
        stateFingerprint,
        snapshot
      };
      const summary = summarizePlan(plan);
      ui.setSummary(
        `${summary.cutCount} cuts, ${summary.removedSeconds.toFixed(2)} s removed, ` +
          `${summary.rejectionCount} rejected, ${summary.warningCount} warnings`
      );
      for (const rejection of plan.rejections || []) {
        ui.log(describeRejection(rejection), 'warn');
      }
      for (const warning of plan.warnings || []) {
        ui.log(warning, 'warn');
      }
      if (result.runDirectory) {
        ui.log(`Evidence of this run: ${result.runDirectory}`, 'muted');
      }
      if (summary.cutCount > 0) {
        ui.log(`Cut plan ready: ${summary.cutCount} ranges, ${summary.removedSeconds.toFixed(2)} s.`, 'ok');
      } else if (summary.rejectionCount > 0) {
        ui.log(
          'No approved cut, see the rejections. Unknown host values are limits, not silence.',
          'warn'
        );
      } else {
        ui.log('No silences found.', 'ok');
      }
    } catch (error) {
      ui.log(`Analysis failed: ${error.message}`, 'error');
    } finally {
      setBusy('', false);
    }
  }

  async function apply() {
    if (state.running || !state.plan || !state.analyzed) {
      if (!state.plan || !state.analyzed) {
        ui.log('Please analyse first.', 'warn');
      }
      return;
    }
    setBusy('Checking and cutting ...', true);
    try {
      const generation = state.generation;
      if (state.capabilities.nativeTimeline) {
        // Some master mixer state has no public reader. Re-render immediately
        // before cutting and require exactly the same cut operations.
        const analyzed = state.analyzed;
        setBusy('Premiere checks the current audio mix again ...', true);
        const rendered = await host.call('renderAudio', {
          expectedIdentity: analyzed.identity,
          expectedItemFingerprint: analyzed.itemFingerprint,
          expectedStateFingerprint: analyzed.stateFingerprint,
          analysisTracks: analyzed.snapshot.analysisTracks,
          outputPath: engine.renderPath()
        });
        if (!rendered.ok) { ui.log(rendered.error, 'error'); invalidate('Audio export failed'); return; }
        const checked = await engine.run({...analyzed.snapshot,
          renderedMixdown: {mediaPath: rendered.parsed.mediaPath, analysisTracks: analyzed.snapshot.analysisTracks}});
        if (generation !== state.generation) { ui.log('Settings changed during the check. Please analyse again.', 'warn'); return; }
        const operations = plan => JSON.stringify({intervals: plan.intervals, removals: plan.removals,
          razorPoints: plan.razorPoints, expectedDurationDeltaTicks: plan.expectedDurationDeltaTicks});
        if (!checked.ok || !checked.envelope?.plan || operations(checked.envelope.plan) !== operations(state.plan)) {
          ui.log('The audio mix or its silences have changed. Please analyse again.', 'warn');
          invalidate('Current audio mix differs'); return;
        }
      }
      const result = await applyWorkflow({
        callHost: host.call,
        plan: state.plan,
        analyzed: state.analyzed,
        capabilities: state.capabilities
      });
      if (result.ok) {
        ui.log(result.applied.message, 'ok');
        ui.log('Readback: copy and original match the expectation.', 'ok');
      } else {
        ui.log(result.error, 'error');
        ui.log('Nothing else is changed. The original sequence stays untouched.', 'muted');
      }
      // A used plan must not stay actionable for the same state.
      invalidate(result.ok ? 'Cut finished' : 'Cut stopped');
    } catch (error) {
      ui.log(`Cut stopped: ${error.message}`, 'error');
      invalidate('Unexpected error');
    } finally {
      setBusy('', false);
    }
  }

  return {
    readSequence,
    analyze,
    apply,
    invalidate,
    getState: () => state,
    canApply
  };
}
