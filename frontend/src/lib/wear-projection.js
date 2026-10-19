// The phone → watch projection: openGym's persisted document, reduced to the ~12 fields the watch
// screens render. Contract: `docs/protocol.md` §3.1; the watch's own reader is
// `android/app/src/main/java/ch/duartesantos/opengym/wear/data/WorkoutProjection.kt`.
//
// The watch never sees `opengym-state.json`. Everything here is derived from the store's `S` (and,
// for the rest, from `useUI`'s timer, which openGym keeps *outside* S — see `gym_rest` in
// `store/useUI.js`). Keeping the derivation pure is what makes it testable without a device and
// what lets the same values be asserted against a real state document.
//
// Two rules the whole protocol rests on, and this file is where they are honoured:
//
//  1. `rest.endsAt` is an ABSOLUTE epoch-ms deadline, never a countdown. A frame that arrives 20 s
//     late still yields the right remaining time on the watch.
//  2. The VOLATILE part of the rest (how much is left right now) is not part of the projection at
//     all: `left` is only meaningful while paused. That is why a ticking countdown produces no new
//     frames and no new `rev`.
import { exerciseNameFor } from './i18n.js'
import { exOr } from './exercises.js'
import { lastEntryFor } from './history.js'
import { sessionHistory } from './backfill.js'
import { restSecFor } from './supersetFlow.js'
import { pyramidRestFor } from './pyramid.js'

/** Index of the first set not yet done, or -1 when every set is done. Same as the watch's `openSetIndex`. */
export function openSetIndex(sets) {
  if (!Array.isArray(sets)) return -1
  return sets.findIndex(s => !s?.done)
}

/**
 * "Set 1/4": `count { done } + 1`, clamped so a finished exercise reads "Set 4/4" and not "Set 5/4".
 * Mirrors the watch's `currentSetIndex()`.
 */
export function currentSetIndex(sets) {
  if (!Array.isArray(sets) || !sets.length) return 0
  const open = openSetIndex(sets)
  return open < 0 ? sets.length : open + 1
}

/** The last set done before the open one, within this exercise — the "previous set this session" hint. */
export function previousDoneSet(sets) {
  if (!Array.isArray(sets)) return null
  const open = openSetIndex(sets)
  const upTo = open < 0 ? sets.length : open
  for (let i = upTo - 1; i >= 0; i--) if (sets[i]?.done) return sets[i]
  return null
}

const posNumber = v => (Number.isFinite(Number(v)) ? Number(v) : null)
const posInt = v => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null)

/**
 * The profile's unit, total: only the exact string `'lb'` is pounds (lib/plates.js, lib/dumbbells.js
 * spell the same rule in the same way).
 */
export const unitOf = S => (S?.unit === 'lb' ? 'lb' : 'kg')

/**
 * A stored weight (in the profile's own unit — openGym keeps every weight in `S.unit`) as the kg the
 * wire carries.
 *
 * **Exact division, no rounding.** openGym's `convertWeight(v,'lb','kg')` rounds to 0.25 kg, which
 * would move 110 lb to 110.23 lb on the way back and make the watch's display disagree with the
 * document. The one rounding in this loop belongs to the watch, which snaps to the profile's own
 * lattice (`WeightUnit.clampDisplay`). `weightKg` is the raw number for a kg profile, so a kg
 * profile's frame is byte-for-byte what it was before this existed.
 */
const wireKg = (v, unit) => {
  const n = posNumber(v)
  if (n === null) return null
  return unit === 'lb' ? n / LB_PER_KG : n
}

/** Pounds per kilogram, from lib/units.js — the same constant the watch's `LB_PER_KG` holds. */
export const LB_PER_KG = 2.2046226218

/**
 * The one resolver every exercise name goes through — `exerciseName` and `entries[].name` alike,
 * so a row's label cannot be a different string from the header's (plan §2.1 rule 3). Never empty:
 * it falls back to the raw id, and to `''` only if the entry has no id either.
 */
function nameOf(entry) {
  return exerciseNameFor(exOr(entry?.id)) || String(entry?.id ?? '')
}

/**
 * `startedAt`: `active.start` as epoch millis, or **null**.
 *
 * Deliberately not `posNumber(A.start) ?? 0`: `active.start` is 0 for a session that has not really
 * started (`components/TabBar.jsx` gates on `start > 0`), and passing that 0 on would render a
 * 20 491-day workout timer on the watch. Missing, unparseable, zero and negative all mean "the
 * watch hides the timer" (plan §2.1 rule 5).
 */
function startedAtOf(A) {
  const at = posNumber(A?.start)
  return at !== null && at > 0 ? Math.round(at) : null
}

/**
 * `entries[]` for the list: every exercise in the session, in order, with its progress.
 *
 * `index` is carried explicitly *and* is the array position, so a consumer that filters or sorts
 * cannot silently mis-map (plan §2.1 rule 2). `setsTotal === 0` is legal — a zero-set exercise.
 * `setsDone` is bounded by `setsTotal` by construction (`filter` over the same array, plan §2.1
 * rule 4).
 */
export function projectEntries(A) {
  const entries = A?.entries
  if (!Array.isArray(entries)) return []
  return entries.map((entry, index) => {
    const sets = Array.isArray(entry?.sets) ? entry.sets : []
    return {
      index,
      name: nameOf(entry),
      setsDone: sets.filter(s => s?.done).length,
      setsTotal: sets.length,
    }
  })
}

/** Whole seconds of rest this exercise will start once no rest is running. */
export function restWhenIdleSeconds(S) {
  const fallback = Math.max(0, Math.round(posNumber(S?.restSec) ?? 0))
  const entries = S?.active?.entries
  if (!Array.isArray(entries) || !entries.length) return fallback
  const at = Math.min(Math.max(Math.round(posNumber(S.active.cur) ?? 0), 0), entries.length - 1)
  const entry = entries[at]
  const sets = Array.isArray(entry?.sets) ? entry.sets : []
  const open = openSetIndex(sets)
  const setRest = { idx: at, sec: pyramidRestFor(entry?.target, sets, open < 0 ? 0 : open) }
  return Math.max(0, Math.round(posNumber(restSecFor(entries, [at], fallback, setRest)) ?? 0))
}

/**
 * `workout` for the frame, or null when no session is running. Null is not an error and not
 * "phone unreachable" (protocol §6) — it means there is nothing to mirror.
 */
export function projectWorkout(S) {
  const A = S?.active
  const entries = A?.entries
  if (!A || !Array.isArray(entries) || !entries.length) return null

  // The unit the WEIGHTS below are converted out of. The wire is always kg (protocol §3.1); this is
  // carried so the watch can render kg back in the number the user reads.
  const unit = unitOf(S)

  const at = Math.min(Math.max(Math.round(posNumber(A.cur) ?? 0), 0), entries.length - 1)
  const entry = entries[at]
  const sets = Array.isArray(entry?.sets) ? entry.sets : []
  const open = openSetIndex(sets)
  const openRow = open >= 0 ? sets[open] : null
  const lastRow = sets.length ? sets[sets.length - 1] : null

  // The `prev. 50.0 kg x 10` hint: a set done earlier in THIS session wins over last session's
  // history, exactly as the watch resolves it (`toWorkoutState`).
  const inSession = previousDoneSet(sets)
  let previous = inSession
  if (!previous) {
    const last = lastEntryFor(sessionHistory(S), entry.id, entry.rid)
    const done = Array.isArray(last?.sets) ? last.sets.filter(s => s?.done) : []
    previous = done.length ? done[done.length - 1] : null
  }

  return {
    id: String(A.id ?? ''),
    name: String(A.name ?? ''),
    exerciseIndex: at,
    exerciseCount: entries.length,
    exerciseName: nameOf(entry),
    setIndex: currentSetIndex(sets),
    // Plan §2.1: the list and the timer need the session's start and every exercise's progress.
    startedAt: startedAtOf(A),
    entries: projectEntries(A),
    setCount: sets.length,
    // The open set is what the watch's spinner edits; when every set is done it shows the last one.
    // Task 2: the document holds the profile's unit — a `w` of 110 on an lb profile is 110 lb — so
    // this is the ONE place that turns it into the kg the wire promises.
    weightKg: wireKg(openRow?.w, unit) ?? wireKg(lastRow?.w, unit) ?? 0,
    reps: posInt(openRow?.r) ?? posInt(lastRow?.r) ?? 1,
    previousWeightKg: previous ? wireKg(previous.w, unit) : null,
    previousReps: previous ? posInt(previous.r) : null,
    // Task 2: `"kg"` or `"lb"`. Always written; the watch treats anything but `"lb"` as kg.
    unit,
  }
}

/**
 * `rest` for the frame, from `useUI`'s timer.
 *
 * `running` is false for a rest that has run out ("Ready") as well as for no rest at all; the two
 * differ only in `total`. A paused rest carries `left` and no deadline, because the watch must not
 * resume a clock it does not know the start of (protocol §3.1).
 */
export function projectRest(S, timer, now = Date.now()) {
  const restWhenIdle = restWhenIdleSeconds(S)
  const paused = !!timer?.paused
  const running = !!timer && !paused && !timer.ready && Number.isFinite(Number(timer.endsAt)) && Number(timer.endsAt) > now
  const total = running || paused ? Math.max(0, Math.round(posNumber(timer?.total) ?? 0)) : restWhenIdle

  return {
    running,
    endsAt: running ? Math.round(Number(timer.endsAt)) : null,
    total,
    paused,
    left: paused ? Math.max(0, Math.round(posNumber(timer?.left) ?? 0)) : null,
    restWhenIdle,
  }
}

/** `{ workout, rest }` — the payload half of a `state` frame. */
export function projectState(S, timer, now = Date.now()) {
  return { workout: projectWorkout(S), rest: projectRest(S, timer, now) }
}

/**
 * Stable identity of a projection. The publisher only bumps `rev` when this changes, so a ticking
 * countdown — which does not appear in the projection at all — never invalidates the `baseRev` a
 * relative command (`adjustWeight`, `adjustReps`) was issued against.
 */
export function projectionKey(projection) {
  return JSON.stringify(projection)
}
