/**
 * Open Silences agent bridge: file protocol shared by the CEP bridge and the CLI.
 *
 * Pure module without Node or CEP imports, so both sides and the tests use the
 * same rules. Only named Open Silences host calls travel through the queue;
 * there is no way to send raw ExtendScript.
 */
export const PROTOCOL_VERSION = 1;
export const ALLOWED_CALLS = Object.freeze(['readSequence','readItems','readItemsOfSequence','prepareCut','renderAudio','apply']);
export const BRIDGE_SUBPATH = Object.freeze(['Library','Application Support','open-silences','bridge']);
export const HEARTBEAT_INTERVAL_MS = 2000;
export const HEARTBEAT_STALE_MS = 10000;
export const COMMAND_MAX_AGE_MS = 120000;
export const COMMAND_PATTERN = /^command-([A-Za-z0-9-]{8,64})\.json$/;
const ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

export const commandFile = id => `command-${id}.json`;
export const responseFile = id => `response-${id}.json`;

export function validateCommand(value, now) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {ok:false, error:'The command is not an object.'};
  if (value.protocol !== PROTOCOL_VERSION) return {ok:false, error:`Unsupported protocol ${String(value.protocol)}.`};
  if (typeof value.id !== 'string' || !ID_PATTERN.test(value.id)) return {ok:false, error:'The command id is not valid.'};
  if (!ALLOWED_CALLS.includes(value.name)) return {ok:false, error:`The call ${String(value.name)} is not allowed.`};
  if (value.payload !== undefined && (value.payload === null || typeof value.payload !== 'object' || Array.isArray(value.payload))) {
    return {ok:false, error:'The payload must be an object.'};
  }
  if (!Number.isFinite(value.createdAt)) return {ok:false, error:'The command has no creation time.'};
  // A command that waited too long belongs to a client that already gave up.
  if (now - value.createdAt > COMMAND_MAX_AGE_MS) return {ok:false, error:'The command is too old and was not executed.'};
  return {ok:true, command:{protocol:value.protocol, id:value.id, name:value.name, payload:value.payload, createdAt:value.createdAt}};
}

export function isHeartbeatFresh(heartbeat, now) {
  return Boolean(heartbeat) && heartbeat.protocol === PROTOCOL_VERSION && Number.isFinite(heartbeat.t) && now - heartbeat.t <= HEARTBEAT_STALE_MS;
}
