// The openGym phone ↔ watch wire format, version 1 — the phone half.
//
// Contract: `docs/protocol.md`. The watch's encoder/decoder is
// `android/app/src/main/java/ch/duartesantos/opengym/wear/link/WireProtocol.kt`; this file is the
// same six frames in JavaScript, deliberately hand-written in one place so the two can be diffed
// against the document rather than against each other.
//
// Framing (one JSON object per newline-delimited line on the TCP relay, one DataItem/Message per
// frame on the Data Layer) is the transport's job, not this file's, so everything here is
// unit-testable with no socket and no Android.
//
// Decoding is total, like the watch's: `decodeFrame` answers null for malformed JSON, a missing or
// wrong-typed field, an unknown `type` and an unsupported `v`. A bad frame is dropped and the link
// stays up — a malformed frame must never kill the connection.

/** The only major version that exists today. */
export const PROTOCOL_VERSION = 1

/** A `state` older than this is stale on the watch. It is a badge, never a reason to blank a screen. */
export const STATE_STALE_AFTER_MS = 15000

/** `adjustRest` / `skipRest` are meaningless once their rest has passed; the watch drops them after this. */
export const COMMAND_TTL_MS = 60000

/** How many recently applied command ids the phone answers with `duplicate` (protocol §5.3). */
export const APPLIED_IDS_REMEMBERED = 256

/** Command names, as they appear on the wire (protocol §4; plan §2.2-§2.3 for the three new ones). */
export const COMMANDS = Object.freeze({
  COMPLETE_SET: 'completeSet',
  NEXT_EXERCISE: 'nextExercise',
  PREVIOUS_EXERCISE: 'previousExercise',
  ADJUST_WEIGHT: 'adjustWeight',
  ADJUST_REPS: 'adjustReps',
  ADJUST_REST: 'adjustRest',
  SKIP_REST: 'skipRest',
  // M7.1, plan §2.2: the workout list's tap. Absolute and idempotent — it writes `active.cur`.
  SELECT_EXERCISE: 'selectExercise',
  // M7.1, plan §2.3: the exercise page's drag wheel, one absolute frame per gesture on release.
  SET_WEIGHT: 'setWeight',
  SET_REPS: 'setReps',
})

/**
 * Relative commands are answered `rejected: stale` when the phone's rev has moved (protocol §5.4).
 * `selectExercise`/`setWeight`/`setReps` are deliberately **not** here: they are absolute, so the
 * value *is* the user's intent and a late delivery is still correct (plan §2.2-§2.3).
 */
export const RELATIVE_COMMANDS = Object.freeze([COMMANDS.ADJUST_WEIGHT, COMMANDS.ADJUST_REPS])

export const ACK_APPLIED = 'applied'
export const ACK_DUPLICATE = 'duplicate'
export const ACK_REJECTED = 'rejected'

export const REASON_STALE = 'stale'
export const REASON_NO_WORKOUT = 'noWorkout'
export const REASON_INVALID = 'invalid'

// --- encoding -----------------------------------------------------------------------------------

/** `{ "v":1, "type":"hello", "role":…, "proto":[…], "sentAt":… }`. */
export function encodeHello(role, sentAt, proto = [PROTOCOL_VERSION]) {
  return JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello', role, proto, sentAt })
}

/**
 * `{ "v":1, "type":"state", "rev":…, "sentAt":…, "workout":…, "rest":… }`.
 *
 * `projection` is `{ workout, rest }` from `lib/wear-projection.js` — already the exact watch-facing
 * shape (protocol §3.1), so this only wraps it in the envelope.
 */
export function encodeState(rev, sentAt, projection) {
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'state',
    rev,
    sentAt,
    workout: projection?.workout ?? null,
    rest: projection?.rest ?? null,
  })
}

/** `{ "v":1, "type":"ack", "id":…, "result":…, "reason":…, "rev":…, "sentAt":… }`. */
export function encodeAck(id, result, reason, rev, sentAt) {
  return JSON.stringify({ v: PROTOCOL_VERSION, type: 'ack', id, result, reason: reason ?? null, rev, sentAt })
}

/** `{ "v":1, "type":"pong", "t":… }`. */
export function encodePong(t) {
  return JSON.stringify({ v: PROTOCOL_VERSION, type: 'pong', t })
}

// --- decoding -----------------------------------------------------------------------------------

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)
const str = v => (typeof v === 'string' ? v : null)
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const int = v => (Number.isInteger(v) ? v : null)
const bool = v => (typeof v === 'boolean' ? v : null)

/**
 * Parses one frame. Returns null for anything the phone cannot act on — see the header. Never
 * throws: the transport hands it whatever arrived on the wire.
 */
export function decodeFrame(text) {
  if (typeof text !== 'string') return null
  let obj
  try {
    obj = JSON.parse(text.trim())
  } catch {
    return null
  }
  if (!isObject(obj)) return null
  if (int(obj.v) !== PROTOCOL_VERSION) return null

  switch (obj.type) {
    case 'hello': {
      const role = str(obj.role)
      if (role !== 'watch' && role !== 'phone') return null
      if (!Array.isArray(obj.proto)) return null
      const proto = obj.proto.filter(Number.isInteger)
      return { type: 'hello', role, proto, sentAt: num(obj.sentAt) ?? 0 }
    }
    case 'state': {
      const rev = num(obj.rev)
      if (rev === null) return null
      const workout = obj.workout == null ? null : decodeWorkout(obj.workout)
      if (obj.workout != null && !workout) return null
      const rest = decodeRest(obj.rest)
      if (!rest) return null
      return { type: 'state', rev, sentAt: num(obj.sentAt) ?? 0, workout, rest }
    }
    case 'ack': {
      const id = str(obj.id)
      const result = str(obj.result)
      if (id === null || result === null) return null
      return { type: 'ack', id, result, reason: str(obj.reason), rev: num(obj.rev) ?? 0, sentAt: num(obj.sentAt) ?? 0 }
    }
    case 'command': {
      const id = str(obj.id)
      const name = str(obj.name)
      if (id === null || name === null) return null
      const args = obj.args == null ? {} : obj.args
      if (!isObject(args)) return null
      return {
        type: 'command',
        id,
        name,
        baseRev: num(obj.baseRev),
        issuedAt: num(obj.issuedAt) ?? 0,
        args,
      }
    }
    case 'ping':
      return { type: 'ping', t: num(obj.t) ?? 0 }
    case 'pong':
      return { type: 'pong', t: num(obj.t) ?? 0 }
    default:
      return null
  }
}

export function decodeWorkout(raw) {
  if (!isObject(raw)) return null
  const id = str(raw.id)
  const name = str(raw.name)
  const exerciseName = str(raw.exerciseName)
  const exerciseIndex = int(raw.exerciseIndex)
  const exerciseCount = int(raw.exerciseCount)
  const setIndex = int(raw.setIndex)
  const setCount = int(raw.setCount)
  const weightKg = num(raw.weightKg)
  const reps = int(raw.reps)
  if (id === null || name === null || exerciseName === null) return null
  if (exerciseIndex === null || exerciseCount === null) return null
  if (setIndex === null || setCount === null || weightKg === null || reps === null) return null
  return {
    id,
    name,
    exerciseIndex,
    exerciseCount,
    exerciseName,
    setIndex,
    setCount,
    weightKg,
    reps,
    previousWeightKg: num(raw.previousWeightKg),
    previousReps: int(raw.previousReps),
    // Plan §2.1. `startedAt` is deliberately NOT `num(raw.startedAt) ?? 0`: an absent or
    // unparseable start must decode as null, or the watch renders a 20 491-day timer.
    startedAt: num(raw.startedAt),
    entries: decodeEntries(raw.entries),
  }
}

/**
 * `workout.entries[]` — the list rows (plan §2.1).
 *
 * Returns `null` when the field is absent (an older phone build, or a recorded TCP fixture: the
 * watch must degrade to a one-row list, not crash) and `null` when the array is there but is not
 * wholly well-formed — a partial list would break the `entries[i].index === i` guarantee that the
 * explicit index exists to protect, and "no list" is a case both sides already handle.
 */
export function decodeEntries(raw) {
  if (!Array.isArray(raw)) return null
  const out = []
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i]
    if (!isObject(row)) return null
    const index = int(row.index)
    const name = str(row.name)
    const setsDone = int(row.setsDone)
    const setsTotal = int(row.setsTotal)
    if (index !== i || name === null || setsDone === null || setsTotal === null) return null
    if (setsTotal < 0 || setsDone < 0 || setsDone > setsTotal) return null
    out.push({ index, name, setsDone, setsTotal })
  }
  return out
}

export function decodeRest(raw) {
  if (!isObject(raw)) return null
  const running = bool(raw.running)
  const total = int(raw.total)
  const paused = bool(raw.paused)
  if (running === null || total === null || paused === null) return null
  return {
    running,
    endsAt: num(raw.endsAt),
    total,
    paused,
    left: int(raw.left),
    restWhenIdle: int(raw.restWhenIdle) ?? 0,
  }
}

// --- negotiation and policy ---------------------------------------------------------------------

/** The highest version both sides understand, or null when the lists do not intersect (protocol §2). */
export function negotiate(local, remote) {
  const there = new Set(Array.isArray(remote) ? remote : [])
  const both = (Array.isArray(local) ? local : []).filter(v => there.has(v))
  return both.length ? Math.max(...both) : null
}

/**
 * The bounded set of recently applied command ids (protocol §5.3). A repeat of an id in here is
 * answered `duplicate` without applying it, which is what makes the watch's retry safe.
 */
export class AppliedIdLog {
  constructor(limit = APPLIED_IDS_REMEMBERED) {
    this.limit = limit
    this.seen = new Set()
    this.order = []
  }

  has(id) {
    return this.seen.has(id)
  }

  remember(id) {
    if (this.seen.has(id)) return
    this.seen.add(id)
    this.order.push(id)
    while (this.order.length > this.limit) this.seen.delete(this.order.shift())
  }

  get size() {
    return this.seen.size
  }
}

/** `{ endsAt, total, paused, left }` — the shape `gym_rest` holds and the frame carries (protocol §3.1). */
export function encodeRestForWire(rest) {
  return {
    running: !!rest?.running,
    endsAt: rest?.endsAt ?? null,
    total: Math.round(rest?.total || 0),
    paused: !!rest?.paused,
    left: rest?.left ?? null,
    restWhenIdle: Math.round(rest?.restWhenIdle || 0),
  }
}
