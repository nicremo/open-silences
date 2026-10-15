/**
 * Command line arguments of open-silences. Defaults follow the panel's
 * Standard pacing: entire timeline, A1, four times 160 ms, with -46 dB.
 */
import {parseArgs} from 'node:util';
import {PRESETS, TIMING_FIELDS} from '../js/workflow.js';

export const CLI_DEFAULTS = Object.freeze({scope:'entire', tracks:['A1'], threshold:-46, preset:'standard', cutScope:'selection'});
export const PRESET_NAMES = Object.freeze({standard:'mine', calm:'calm', relaxed:'measured', fluid:'paced', energetic:'energetic', tight:'jumpy'});
const COMMANDS = ['status', 'sequence', 'estimate', 'preview', 'cut'];
const SCOPES = ['entire', 'inout', 'selected'];
const CUT_SCOPES = ['selection', 'dialogue'];
const TIMING_OPTIONS = {minPause:'min-pause', minSpeech:'min-speech', leadIn:'lead-in', tail:'tail'};
const VALUE_OPTIONS = ['scope', 'tracks', 'threshold', 'preset', 'min-pause', 'min-speech', 'lead-in', 'tail', 'min-cut-spacing', 'cut-scope', 'timeout', 'engine'];

export class UsageError extends Error {}

export const USAGE = `Usage: open-silences <command> [options]

Commands:
  status     Is the Premiere bridge running? Which engine is used?
  sequence   Active sequence with its audio tracks
  estimate   Estimate the noise floor of the chosen tracks
  preview    Analyse and report the cuts, change nothing (no backup)
  cut        Backup, analyse, cut and verify. Requires --yes

Options (defaults: entire timeline, A1, -46 dB, Standard pacing):
  --scope entire|inout|selected   Range (default entire)
  --tracks A1[,A2]                Analysis tracks (default A1)
  --threshold <dB>|auto           Noise floor -60..0 (default -46), auto estimates first
  --preset standard|calm|relaxed|fluid|energetic|tight   Pacing (default standard)
  --min-pause <ms> --min-speech <ms> --lead-in <ms> --tail <ms>   Override one timing
  --min-cut-spacing <ms>          Thin out cuts at most this far apart (default 0, off)
  --cut-scope selection|dialogue  Cut every track in the range, or only under speech clips (default selection)
  --no-backup                     Cut without a backup sequence
  --verify-mix                    Render the mix a second time right before the cut
  --no-readback                   Skip the check of every clip after the cut
  --yes                           Confirm the cut
  --json                          One JSON object on stdout
  --timeout <s>                   Per host call (default 1800)
  --engine <path>                 Engine binary (default: bundled engine)
`;

// parseArgs rejects "--threshold -50" as ambiguous, so value options are
// joined with their value first: "--threshold=-50".
function joinValues(argv) {
  const joined = [];
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].startsWith('--') ? argv[i].slice(2) : null;
    if (name && VALUE_OPTIONS.includes(name) && i + 1 < argv.length) joined.push(`${argv[i]}=${argv[++i]}`);
    else joined.push(argv[i]);
  }
  return joined;
}

export function parseCliArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({args:joinValues(argv), allowPositionals:true, strict:true, options:{
      scope:{type:'string'}, tracks:{type:'string'}, threshold:{type:'string'}, preset:{type:'string'},
      'min-pause':{type:'string'}, 'min-speech':{type:'string'}, 'lead-in':{type:'string'}, tail:{type:'string'},
      'min-cut-spacing':{type:'string'}, 'cut-scope':{type:'string'},
      'no-backup':{type:'boolean'}, 'verify-mix':{type:'boolean'}, 'no-readback':{type:'boolean'},
      yes:{type:'boolean'}, json:{type:'boolean'}, timeout:{type:'string'}, engine:{type:'string'}, help:{type:'boolean'}
    }});
  } catch (error) { throw new UsageError(error.message); }
  const {values, positionals} = parsed;
  const command = values.help ? 'help' : positionals[0];
  if (command !== 'help' && !COMMANDS.includes(command)) throw new UsageError(command ? `Unknown command ${command}.` : 'A command is required.');
  if (positionals.length > 1) throw new UsageError(`Unexpected argument ${positionals[1]}.`);
  if (command === 'cut' && !values.yes) throw new UsageError('cut changes the timeline. Add --yes to confirm, or run preview first.');

  const scope = values.scope ?? CLI_DEFAULTS.scope;
  if (!SCOPES.includes(scope)) throw new UsageError(`Unknown scope ${scope}.`);

  const trackNames = (values.tracks ?? CLI_DEFAULTS.tracks.join(',')).split(',').map(name => name.trim());
  const analysisTracks = trackNames.map(name => {
    const match = /^A([1-9][0-9]?)$/i.exec(name);
    if (!match) throw new UsageError(`Track ${name} is not an audio track like A1.`);
    return {kind:'audio', index:Number(match[1]) - 1};
  });

  const presetName = values.preset ?? CLI_DEFAULTS.preset;
  const preset = PRESETS[PRESET_NAMES[presetName]];
  if (!preset) throw new UsageError(`Unknown preset ${presetName}.`);
  const settings = {threshold:CLI_DEFAULTS.threshold};
  TIMING_FIELDS.forEach((field, i) => { settings[field] = preset.values[i]; });
  for (const [field, option] of Object.entries(TIMING_OPTIONS)) {
    if (values[option] === undefined) continue;
    const value = Number(values[option]);
    if (values[option] === '' || !Number.isFinite(value) || value < 0 || value > 10000) throw new UsageError(`--${option} must be 0 to 10000 ms.`);
    settings[field] = value;
  }

  settings.minCutSpacing = 0;
  if (values['min-cut-spacing'] !== undefined) {
    const value = Number(values['min-cut-spacing']);
    if (values['min-cut-spacing'] === '' || !Number.isFinite(value) || value < 0 || value > 10000) throw new UsageError('--min-cut-spacing must be 0 to 10000 ms.');
    settings.minCutSpacing = value;
  }
  const cutScope = values['cut-scope'] ?? CLI_DEFAULTS.cutScope;
  if (!CUT_SCOPES.includes(cutScope)) throw new UsageError(`Unknown cut scope ${cutScope}.`);

  const autoThreshold = values.threshold === 'auto';
  if (values.threshold !== undefined && !autoThreshold) {
    const threshold = Number(values.threshold);
    if (values.threshold === '' || !Number.isFinite(threshold) || threshold < -60 || threshold > 0) throw new UsageError('--threshold must be -60 to 0 dB or auto.');
    settings.threshold = threshold;
  }

  const timeoutSeconds = values.timeout === undefined ? 1800 : Number(values.timeout);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new UsageError('--timeout must be a positive number of seconds.');

  return {command, json:Boolean(values.json), yes:Boolean(values.yes), autoThreshold, timeoutMs:timeoutSeconds * 1000,
    engine:values.engine, config:{scope, analysisTracks, settings, cutScope,
      safety:{backup:!values['no-backup'], verifyMix:Boolean(values['verify-mix']), readback:!values['no-readback']}}};
}
