// The phone half of the openGym phone ↔ watch link. Contract: `docs/protocol.md`.
//
// What this file is:
//  - the projection publisher: on every write of the saved document (and every rest-timer change)
//    it derives the watch-facing `{ workout, rest }` and sends a `state` frame;
//  - the command receiver: a `command` frame from the watch is applied through the same store
//    action the phone's own buttons use, then answered with an `ack`;
//  - the protocol policy the phone owns: version negotiation, the `rev` high-water for relative
//    commands, and the bounded set of applied command ids that makes a replay safe.
//
// What this file is not: the transport. `WearBridgePlugin.java` owns the TCP socket and the
// newline framing, and knows nothing about JSON beyond passing a line through. That split is what
// lets the identical frames travel the Data Layer later without touching any of this.
//
// Answering the ack is the phone's job and only the phone's: the watch never applies a command
// optimistically, so a lost ack means "the tap did nothing" rather than a local lie (protocol §5.3).
import { Capacitor, registerPlugin } from '@capacitor/core'
import { MOBILE } from './mobile.js'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { projectState, projectionKey } from './wear-projection.js'
import { publishWear, setWearSink } from './wear-sink.js'
import { setWearSessionDriver, syncWearSession, wearSessionStatus } from './wear-session.js'
import { maybeLaunchWatch, setWearLaunchDriver, wearLaunchStatus } from './wear-launch.js'
import {
  ACK_APPLIED,
  ACK_DUPLICATE,
  ACK_REJECTED,
  AppliedIdLog,
  PROTOCOL_VERSION,
  RELATIVE_COMMANDS,
  REASON_INVALID,
  REASON_STALE,
  decodeFrame,
  encodeAck,
  encodeHello,
  encodePong,
  encodeState,
  negotiate,
} from './wear-frames.js'

export const DEFAULT_TCP_PORT = 8765

export const REV_KEY = 'gym_wear_rev'

let bridge = null
let started = false
/**
 * Monotonic for as long as this install's storage holds [REV_KEY] (protocol §5.2).
 *
 * Deliberately **not** a plain per-module counter: this module is re-created by every page load
 * (a WebView reload, a renderer restart, an app start) while the Data Layer link to the watch is
 * not. A `rev` that restarted at 1 there would sit below the watch's high-water mark, which only a
 * phone `hello` resets — so the watch would silently drop every `state` we publish, in one
 * direction only, until the count climbed back past the mark. That is the defect this variable's
 * persistence fixes; `docs/notes/18-rev-restart-fix.md` has the hardware evidence.
 */
let rev = 0

/**
 * Whether this context found no predecessor's [rev]: a genuinely **new epoch**, whose low revisions
 * the watch can only accept if it is told (protocol §5.2). Exactly the case persistence cannot
 * cover — storage cleared, first run after an install — and the only case [announceEpoch] fires in.
 */
let freshEpoch = false

/**
 * Reads the epoch back from storage. Storage that cannot be read is treated as a fresh epoch, which
 * is the safe direction: the watch is told to forget its mark rather than left holding one above
 * everything this context will ever publish.
 */
function restoreEpoch() {
  try {
    const saved = Number(localStorage.getItem(REV_KEY))
    rev = Number.isInteger(saved) && saved > 0 ? saved : 0
  } catch {
    rev = 0
  }
  freshEpoch = rev === 0
}

/**
 * Records the epoch, so the next page load continues it instead of restarting at 1.
 *
 * A storage that refuses the write is not fatal and not silent either: the next context reads
 * nothing, calls itself a fresh epoch, and announces itself to the watch — which is the same path
 * a first install takes.
 */
function saveRev() {
  try {
    localStorage.setItem(REV_KEY, String(rev))
  } catch {
    /* an unpersisted epoch announces itself next time; it never rewinds quietly */
  }
}

restoreEpoch()

let lastKey = null
let lastFrame = null
let compatible = true
let negotiatedVersion = null
let connected = false
const appliedIds = new AppliedIdLog()
const trace = []

function note(entry) {
  trace.push({ at: Date.now(), ...entry })
  if (trace.length > 40) trace.shift()
}

/** Sends one already-encoded frame. Never throws: a lost write is the transport's business. */
function send(frame) {
  if (!bridge) return Promise.resolve({ sent: false })
  return bridge.send({ frame }).catch(() => ({ sent: false }))
}

/**
 * Sends the current projection, bumping `rev` only when the projected content actually changed.
 *
 * Only-on-change matters beyond tidiness: `adjustWeight`/`adjustReps` are refused as `stale` when
 * the phone's rev has moved past the one the watch issued them against (protocol §5.4). A ticking
 * countdown is not part of the projection (the rest carries an absolute deadline), so a minute of
 * rest produces no new rev and the watch's weight tap is still issued against the live revision.
 *
 * `force` — a new connection, or a fresh `hello`: send even when nothing changed. The watch resets
 * its high-water mark on our `hello`, so re-sending the same rev is legitimate in that case.
 *
 * `bumpRev` — guarantee a **strictly higher** rev even when the content is byte-identical. Plan
 * §2.2/§2.3 require it for an `applied` command that moved nothing: `selectExercise` onto the index
 * that was already current, or a `setWeight` whose value was already stored. The watch's tapped row
 * stays *pending* until it sees a `state` with `exerciseIndex == index` (§2.4), so an `applied` that
 * published no new frame would leave that row pending for ever.
 */
function publish({ force = false, bumpRev = false } = {}) {
  const S = useStore.getState().S
  const timer = useUI.getState().timer
  const projection = projectState(S, timer)
  const key = projectionKey(projection)

  // M4.7: whatever the projection says a workout is, that is what the workout-scoped foreground
  // service is doing — started when one becomes active, stopped when it ends
  // (`lib/wear-session.js`, docs/notes/12-datalayer-decisions.md §4). Deliberately before the
  // change check below: the service follows the workout's existence, not the frame's staleness, and
  // a repeated publish with the same answer sends nothing anyway.
  syncWearSession(projection.workout)

  // M8: the watch app opening itself. The trigger set is ONE constant in `lib/wear-launch.js`
  // (`LAUNCH_POLICY`), deliberately easy to change and deliberately not finalised here.
  maybeLaunchWatch(projection)

  const unchanged = key === lastKey
  if (!force && unchanged && !bumpRev) return lastFrame
  if (unchanged) {
    // Same content. With `force` alone this only bumps when this context has never published
    // (`rev === 0`, the fresh-epoch case); `bumpRev` always bumps, which is the §2.2 rule.
    if (bumpRev || rev === 0) {
      rev += 1
      saveRev()
    }
  } else {
    lastKey = key
    rev += 1
    saveRev()
  }
  lastFrame = encodeState(rev, Date.now(), projection)
  note({ dir: 'out', type: 'state', rev, workout: projection.workout ? projection.workout.exerciseName : null, rest: projection.rest.running })
  send(lastFrame)
  return lastFrame
}

/**
 * Tells the watch that this context's `rev` is a **new epoch**, before the first `state` leaves
 * (protocol §5.2).
 *
 * Only a phone `hello` resets the watch's high-water mark, and on the Data Layer carrier nothing
 * else on the phone side ever would: `onLink` is a *TCP* connect event, and the Data Layer has no
 * per-connection event at all. Without this, a context whose `rev` really does restart — storage
 * cleared, a fresh install, a write that failed — would be below the mark for its whole life.
 *
 * It is not sent when the epoch continues, and that is deliberate rather than an optimisation: a
 * reset while nothing restarted would drop the mark that is still protecting the mirror from a
 * late frame of the previous epoch, so it would weaken the gate to fix nothing.
 */
async function announceEpoch() {
  if (!freshEpoch) return
  freshEpoch = false
  note({ dir: 'out', type: 'hello', epoch: true })
  await send(encodeHello('phone', Date.now(), [PROTOCOL_VERSION]))
}

async function onWatchHello(frame) {
  const negotiated = negotiate([PROTOCOL_VERSION], frame.proto)
  compatible = negotiated !== null
  negotiatedVersion = negotiated
  note({ dir: 'in', type: 'hello', proto: frame.proto, negotiated })
  // The phone always answers `hello`; it is how the watch learns the phone's process restarted and
  // its `rev` may therefore be lower than the last one it saw (protocol §5.2).
  await send(encodeHello('phone', Date.now(), [PROTOCOL_VERSION]))
  if (!compatible) {
    note({ dir: 'out', type: 'hello', incompatible: true })
    return
  }
  publish({ force: true })
}

function ack(id, result, reason) {
  const frame = encodeAck(id, result, reason, rev, Date.now())
  note({ dir: 'out', type: 'ack', id, result, reason, rev })
  return send(frame)
}

async function onCommand(command) {
  if (!compatible) {
    // §2: with no common version the phone does not act on commands at all. Answering nothing is
    // deliberate — an `ack` the watch cannot interpret would be worse than silence.
    note({ dir: 'in', type: 'command', ignored: 'incompatible', name: command.name })
    return
  }
  if (appliedIds.has(command.id)) {
    note({ dir: 'in', type: 'command', name: command.name, replay: true })
    await ack(command.id, ACK_DUPLICATE, null)
    return
  }
  if (RELATIVE_COMMANDS.includes(command.name) && command.baseRev !== rev) {
    // A delta against a value the user is no longer looking at. Answering `stale` and waiting for
    // the fresh `state` is deliberate: applying it would silently change a load they did not choose.
    note({ dir: 'in', type: 'command', name: command.name, stale: { baseRev: command.baseRev, rev } })
    await ack(command.id, ACK_REJECTED, REASON_STALE)
    return
  }

  const ui = useUI.getState()
  // The projection identity before the command, so the ack path can tell whether the command
  // changed anything the wire can see.
  const beforeKey = projectionKey(projectState(useStore.getState().S, ui.timer))
  const result = useStore.getState().applyWatchCommand(command, {
    startRest: ui.startRest,
    addRest: ui.addRest,
    stopRest: ui.stopRest,
    timer: ui.timer,
  })
  note({ dir: 'in', type: 'command', name: command.name, args: command.args, applied: result.applied, reason: result.reason })

  if (result.applied) {
    appliedIds.remember(command.id)
    await ack(command.id, ACK_APPLIED, null)
    // `applyWatchCommand` already persisted, which published through `persist`. A rest-only command
    // does not touch the document, so its new timer state is published here.
    //
    // Plan §2.2/§2.3: an `applied` command must ALWAYS be followed by a fresh `state` carrying a
    // higher `rev`, *including* when it moved nothing — `selectExercise` onto the index that was
    // already current, or a `setWeight` whose value was already stored. A content-changing command
    // has already published, so only the identical case needs `bumpRev`; the key comparison is what
    // decides. Without that bump the watch's tapped row would stay pending for ever.
    const after = projectState(useStore.getState().S, useUI.getState().timer)
    publish(projectionKey(after) === beforeKey ? { bumpRev: true } : {})
  } else {
    await ack(command.id, ACK_REJECTED, result.reason || REASON_INVALID)
  }
}

function onFrame(text) {
  const frame = decodeFrame(text)
  if (!frame) {
    note({ dir: 'in', type: 'dropped' })
    return
  }
  switch (frame.type) {
    case 'hello':
      onWatchHello(frame).catch(() => {})
      return
    case 'command':
      onCommand(frame).catch(() => {})
      return
    case 'ping':
      send(encodePong(frame.t)).catch(() => {})
      return
    default:
      // `state`, `ack` and `pong` are not the phone's to act on.
      note({ dir: 'in', type: frame.type })
  }
}

function onLink(state) {
  connected = !!state?.connected
  note({ dir: 'link', connected, remote: state?.remote })
  if (!connected) return
  // "The phone re-sends its current state to a new connection without waiting to be asked"
  // (protocol §7), and speaks first so the watch has our `proto` list even if it missed ours earlier.
  send(encodeHello('phone', Date.now(), [PROTOCOL_VERSION])).catch(() => {})
  publish({ force: true })
}

/**
 * Starts the link. Android + the mobile build only: the web build has no `WearBridge` plugin and
 * nothing to talk to, so this is a no-op there and the whole module folds away behind `MOBILE`.
 */
export async function startWearLink({ port = DEFAULT_TCP_PORT } = {}) {
  if (started) return bridge
  if (!MOBILE) return null
  if (Capacitor.getPlatform() !== 'android') return null
  started = true

  bridge = registerPlugin('WearBridge')
  await bridge.addListener('frame', ev => onFrame(ev?.text))
  await bridge.addListener('link', ev => onLink(ev))

  // The document's changes come through `persist` (see `lib/wear-sink.js`); the rest countdown
  // lives in `useUI` and is not part of the saved document, so it is watched separately. Only the
  // timer identity is compared — a tick that changes `left` alone is derived, not projected.
  setWearSink(() => publish())
  // The service starts on a projection edge, so the driver is installed before the first publish.
  setWearSessionDriver(call => bridge.session(call))
  // And the launch follows the trigger set in `lib/wear-launch.js`, installed the same way.
  setWearLaunchDriver(call => bridge.launch(call))
  useUI.subscribe((s, prev) => {
    if (s.timer !== prev.timer) publish()
  })

  try {
    await bridge.start({ port })
    note({ dir: 'bridge', started: true, port })
  } catch (e) {
    note({ dir: 'bridge', started: false, error: String(e?.message || e) })
  }

  // Before the first `state`, and after the bridge exists to carry it. A `start()` on a plugin that
  // is already listening resolves without a `link` event (a page reload keeps the socket), so this
  // cannot be left to `onLink`.
  await announceEpoch()
  publish({ force: true })
  return bridge
}

/**
 * Read-only view of the link for the on-device evidence and the debug console.
 *
 * `revEpoch` is `'fresh'` while this context found no persisted `rev` — the state in which
 * [startWearLink] announces itself to the watch — and `'continued'` once it took one over.
 */
export function wearLinkStatus() {
  return {
    started,
    connected,
    rev,
    revEpoch: freshEpoch ? 'fresh' : 'continued',
    compatible,
    negotiatedVersion,
    hasFrame: !!lastFrame,
    applied: appliedIds.size,
    session: wearSessionStatus(),
    launch: wearLaunchStatus(),
    trace,
  }
}

export { publishWear, publish as publishWearState }
