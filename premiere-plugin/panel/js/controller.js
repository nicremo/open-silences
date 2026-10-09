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
      ui.setSummary('Schnittplan verworfen.');
      ui.log(`Schnittplan verworfen: ${reason}`, 'muted');
    }
    state.analyzed = null;
    state.generation += 1;
    ui.setBusy('', state.running, canApply());
  };

  async function readSequence() {
    if (state.running) {
      return;
    }
    invalidate('Sequenz wird neu gelesen');
    state.sequence = null;
    state.capabilities = null;
    setBusy('Lese Sequenz ...', true);
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
      ui.log(`Sequenz gelesen: ${result.parsed.tracks.length} Spuren, ${result.parsed.clipCount} Clips.`);
    } finally {
      setBusy('', false);
    }
  }

  async function analyze() {
    if (state.running || !state.sequence) {
      if (!state.sequence) {
        ui.log('Bitte zuerst die Sequenz lesen.', 'warn');
      }
      return;
    }
    // Busy before the first await: one flight at a time.
    setBusy('Analysiere ...', true);
    const generation = ++state.generation;
    state.plan = null;
    state.analyzed = null;
    try {
      const selection = input.analysisTracks();
      if (selection.length === 0) {
        ui.log('Bitte mindestens eine Audiospur für die Analyse wählen.', 'warn');
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
        ui.log('Die aktive Sequenz ist nicht mehr die gelesene Sequenz, bitte neu lesen.', 'warn');
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
        ui.log('Der Positionsstand passt nicht zur gelesenen Sequenz, bitte neu lesen.', 'warn');
        return;
      }
      const itemFingerprint = originalNow.raw;

      let renderedMixdown = null;
      if (state.capabilities.nativeTimeline) {
        setBusy('Premiere rendert die gewählten Audiospuren. Dieser Schritt ist nicht abbrechbar.', true);
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
        ui.log(`Timeline-Audio exportiert: ${(rendered.parsed.renderMilliseconds / 1000).toFixed(2)} s.`, 'ok');
        setBusy('Stille wird analysiert ...', true);
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
        ui.log(`Schnappschuss nicht möglich: ${error.message}`, 'error');
        return;
      }

      const result = await engine.run(snapshot);
      if (generation !== state.generation) {
        ui.log('Ein neuer Lauf hat diesen ersetzt, Ergebnis verworfen.', 'warn');
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
        `${summary.cutCount} Schnitte, ${summary.removedSeconds.toFixed(2)} s entfernt, ` +
          `${summary.rejectionCount} abgelehnt, ${summary.warningCount} Hinweise`
      );
      for (const rejection of plan.rejections || []) {
        ui.log(describeRejection(rejection), 'warn');
      }
      for (const warning of plan.warnings || []) {
        ui.log(warning, 'warn');
      }
      if (result.runDirectory) {
        ui.log(`Belege dieses Laufs: ${result.runDirectory}`, 'muted');
      }
      if (summary.cutCount > 0) {
        ui.log(`Schnittplan bereit: ${summary.cutCount} Bereiche, ${summary.removedSeconds.toFixed(2)} s.`, 'ok');
      } else if (summary.rejectionCount > 0) {
        ui.log(
          'Kein freigegebener Schnitt, siehe Ablehnungen. Unbekannte Hostwerte sind Grenzen, nicht Stille.',
          'warn'
        );
      } else {
        ui.log('Keine Stillen gefunden.', 'ok');
      }
    } catch (error) {
      ui.log(`Analyse fehlgeschlagen: ${error.message}`, 'error');
    } finally {
      setBusy('', false);
    }
  }

  async function apply() {
    if (state.running || !state.plan || !state.analyzed) {
      if (!state.plan || !state.analyzed) {
        ui.log('Bitte zuerst analysieren.', 'warn');
      }
      return;
    }
    setBusy('Prüfe und schneide ...', true);
    try {
      const generation = state.generation;
      if (state.capabilities.nativeTimeline) {
        // Some master mixer state has no public reader. Re-render immediately
        // before cutting and require exactly the same cut operations.
        const analyzed = state.analyzed;
        setBusy('Premiere prüft den aktuellen Audiomix erneut ...', true);
        const rendered = await host.call('renderAudio', {
          expectedIdentity: analyzed.identity,
          expectedItemFingerprint: analyzed.itemFingerprint,
          expectedStateFingerprint: analyzed.stateFingerprint,
          analysisTracks: analyzed.snapshot.analysisTracks,
          outputPath: engine.renderPath()
        });
        if (!rendered.ok) { ui.log(rendered.error, 'error'); invalidate('Audioexport fehlgeschlagen'); return; }
        const checked = await engine.run({...analyzed.snapshot,
          renderedMixdown: {mediaPath: rendered.parsed.mediaPath, analysisTracks: analyzed.snapshot.analysisTracks}});
        if (generation !== state.generation) { ui.log('Einstellungen während der Prüfung geändert. Bitte neu analysieren.', 'warn'); return; }
        const operations = plan => JSON.stringify({intervals: plan.intervals, removals: plan.removals,
          razorPoints: plan.razorPoints, expectedDurationDeltaTicks: plan.expectedDurationDeltaTicks});
        if (!checked.ok || !checked.envelope?.plan || operations(checked.envelope.plan) !== operations(state.plan)) {
          ui.log('Der Audiomix oder seine Stillen haben sich geändert. Bitte neu analysieren.', 'warn');
          invalidate('Aktueller Audiomix weicht ab'); return;
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
        ui.log('Nachprüfung: Kopie und Original stimmen mit der Erwartung überein.', 'ok');
      } else {
        ui.log(result.error, 'error');
        ui.log('Es wird nichts weiter verändert. Die Originalsequenz bleibt unberührt.', 'muted');
      }
      // A used plan must not stay actionable for the same state.
      invalidate(result.ok ? 'Schnitt abgeschlossen' : 'Schnitt abgebrochen');
    } catch (error) {
      ui.log(`Schnitt abgebrochen: ${error.message}`, 'error');
      invalidate('Unerwarteter Fehler');
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
