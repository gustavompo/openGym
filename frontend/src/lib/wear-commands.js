// The watch → phone commands, applied to the phone's own document.
//
// Contract: `docs/protocol.md` §4. Every branch below is the mutation openGym's own on-screen
// control makes, reusing openGym's own pure helpers — `nextOpenSet` is the one the space bar ticks
// with (Workout.jsx `onKey`), `cascadeWeight` is what a typed weight does, `restSecFor` /
// `warmupRestSecFor` / `restAfterSet` are what `toggle` resolves the earned rest with. The React
// layer that a finger also drives (sheets, scroll reveal, the keyboard blur) is deliberately not
// reproduced here; nothing it does changes the document.
//
// The rest itself is started through `useUI.startRest`, the same action the rest bar's own button
// calls, so the phone's countdown and the watch's are the same clock.
import { bestWeightForEntry, cascadeWeight, supersetUnits, unitOf } from './history.js'
import { isSideSet, isWarmupRow, toggleSide, WEIGHT_ORIGIN_MANUAL } from './workout-model.js'
import { nextOpenSet } from './workout-keys.js'
import { nextUnfinishedUnit, restAfterSet, restSecFor, supersetFlowStep, warmupRestSecFor } from './supersetFlow.js'
import { pyramidRestFor } from './pyramid.js'
import {
  COMMANDS,
  REASON_INVALID,
  REASON_NO_WORKOUT,
} from './wear-frames.js'

/** The protocol's bounds, mirrored from the watch's `WorkoutProjection.kt`. */
export const MIN_WEIGHT_KG = 0
export const MAX_WEIGHT_KG = 500
export const WEIGHT_STEP_KG = 0.5

/**
 * openGym's own pound lattice: `lib/units.js` rounds every lb weight to the nearest 0.5
 * (`Math.round(v * LB_PER_KG * 2) / 2`). Not invented here — it is the grid the phone itself
 * stores lb loads on, so a value this function returns is one openGym could have written.
 *
 * The watch steps 1 lb on an lb profile, which is exactly two of these cells; a 0.5 kg snap would
 * eat that step whole (1 lb = 0.4536 kg), which is why the snap has to happen here.
 */
export const LB_STEP = 0.5

/** Pounds per kilogram, from `lib/units.js` — the same constant the watch's `WeightUnit` holds. */
export const LB_PER_KG = 2.2046226218

/** The heaviest storable pound value: the largest [LB_STEP] cell inside the wire's 500 kg bound. */
export const MAX_LB = Math.floor((MAX_WEIGHT_KG * LB_PER_KG) / LB_STEP) * LB_STEP

export const MIN_REPS = 1
export const MAX_REPS = 99

/** Snaps to 0.5 kg and clamps, absorbing float dust exactly as the watch's `clampWeightKg` does. */
export function clampWeightKg(kg) {
  if (!Number.isFinite(kg)) return MIN_WEIGHT_KG
  const bounded = Math.min(Math.max(kg, MIN_WEIGHT_KG), MAX_WEIGHT_KG)
  return Math.round(bounded / WEIGHT_STEP_KG) * WEIGHT_STEP_KG
}

export function clampReps(reps) {
  return Math.min(Math.max(Math.round(reps) || MIN_REPS, MIN_REPS), MAX_REPS)
}

/**
 * A wire kg as the number openGym STORES for this profile, snapped on the profile's own lattice.
 *
 *  - `kg` profile: `clampWeightKg`, unchanged — 0.5 kg snap, `0..500 kg` clamp.
 *  - `lb` profile: convert, round to the nearest [LB_STEP], then clamp onto that lattice at
 *    [MAX_LB]. This is the step the watch cannot take itself: the wire is kg by contract
 *    (protocol §3.1), so the conversion back into the profile's unit is exactly the phone's job.
 *
 * Idempotent: applying the result of one call as the wire value of the next returns the same store.
 */
export function storedWeightFromKg(kg, unit = 'kg') {
  if (unit !== 'lb') return clampWeightKg(kg)
  const snapped = Math.round((Number(kg) || 0) * (LB_PER_KG / LB_STEP)) * LB_STEP
  // Snap FIRST, then clamp from the top down onto the lattice, so the ceiling is a value the phone
  // would also accept as a wire kg: the largest half-pound that is still <= 500 kg, 1102.0 lb.
  // (Clamping in kg before the snap let 1102.5 lb through, which is 500.09 kg on the wire.)
  return Math.min(Math.max(snapped, MIN_WEIGHT_KG), MAX_LB)
}

/**
 * A stored weight (in the profile's own unit) as the kg the wire carries.
 *
 * `lb`: exact division, deliberately unrounded — openGym's `convertWeight` would round 110 lb to
 * 49.75 kg and then a 1 lb step back would land on the value it started from, i.e. a refused
 * command. `kg`: `clampWeightKg`, which is what this file has always done.
 */
function kgOfStored(stored, unit) {
  return unit === 'lb' ? Number(stored) / LB_PER_KG : clampWeightKg(stored)
}

const clampIndex = (v, size) => Math.min(Math.max(Number.isInteger(v) ? v : 0, 0), Math.max(0, size - 1))

/** The open set of the exercise the marker is on — the set the watch's spinner displays. */
function currentEntry(S) {
  const entries = S?.active?.entries
  if (!Array.isArray(entries) || !entries.length) return null
  const at = clampIndex(S.active.cur, entries.length)
  return { entries, at, entry: entries[at], sets: Array.isArray(entries[at]?.sets) ? entries[at].sets : [] }
}

/**
 * The open set of the exercise the marker is on — the set the watch's spinner displays.
 *
 * The single lookup behind every weight/reps mutation (`adjustWeight`, `adjustReps`, `setWeight`,
 * `setReps`). Plan section 2.3 requires `setWeight`/`setReps` to target *exactly* what
 * `adjustWeight`/`adjustReps` target, so a drag and a crown step cannot edit different sets; that
 * is only guaranteeable if there is one implementation of "which set", and this is it.
 *
 * Returns `{ reason, ctx, i, row }`, with `reason !== null` when there is nothing to edit.
 */
function openSetOf(S) {
  const ctx = currentEntry(S)
  if (!ctx) return { reason: REASON_NO_WORKOUT, ctx: null, i: -1, row: null }
  const i = ctx.sets.findIndex(s => !s?.done)
  if (i < 0) return { reason: REASON_INVALID, ctx: null, i: -1, row: null }
  return { reason: null, ctx, i, row: ctx.sets[i] }
}

/**
 * Writes an absolute weight into the open set — the origin mark and the cascade to the following
 * inherited sets are exactly what a typed weight does (`Workout.jsx` `setField`).
 *
 * Shared by `adjustWeight` and `setWeight` for the same reason `openSetOf` is shared: the delta and
 * the absolute frame must not diverge in anything but how the number was arrived at.
 */
function writeOpenWeight(ctx, i, storedAfter) {
  ctx.sets[i].w = storedAfter
  ctx.sets[i].weightOrigin = WEIGHT_ORIGIN_MANUAL
  ctx.entry.sets = cascadeWeight(ctx.sets, i, storedAfter, undefined, ctx.entry.target?.backoffStep)
}

/**
 * Applies one command to the draft `S`, in place. Returns `{ changed, reason }`.
 *
 * `changed: false` means no write happens at all (not a no-op persist): the command was refused
 * with one of the protocol's `rejected` reasons. Nothing is applied optimistically — the phone's
 * document IS the answer, and the fresh `state` frame that follows is what the watch renders.
 */
export function applyWatchCommandTo(S, ui, cmd) {
  const name = cmd?.name
  if (!S?.active || !Array.isArray(S.active.entries) || !S.active.entries.length) {
    return { changed: false, reason: REASON_NO_WORKOUT }
  }

  switch (name) {
    case COMMANDS.COMPLETE_SET:
      return completeSet(S, ui)
    case COMMANDS.NEXT_EXERCISE: {
      const entries = S.active.entries
      const at = clampIndex(S.active.cur, entries.length)
      if (at >= entries.length - 1) return { changed: false, reason: REASON_INVALID }
      S.active.cur = at + 1
      return { changed: true, reason: null }
    }
    case COMMANDS.PREVIOUS_EXERCISE: {
      const at = clampIndex(S.active.cur, S.active.entries.length)
      if (at <= 0) return { changed: false, reason: REASON_INVALID }
      S.active.cur = at - 1
      return { changed: true, reason: null }
    }
    case COMMANDS.ADJUST_WEIGHT:
      return adjustWeight(S, cmd)
    case COMMANDS.ADJUST_REPS:
      return adjustReps(S, cmd)
    // Plan section 2.3. Absolute, idempotent, safe to replay late, **not** `baseRev`-gated: the value
    // is the user's intent, so a late delivery is still correct. One frame per drag, sent on
    // release — `adjustWeight` is relative and `baseRev`-gated, so a burst of deltas would land as
    // one step and nine `stale` refusals (protocol section 5.4).
    case COMMANDS.SET_WEIGHT:
      return setWeight(S, cmd)
    case COMMANDS.SET_REPS:
      return setReps(S, cmd)
    // Plan section 2.2. Absolute and idempotent like `nextExercise`/`previousExercise`: it moves
    // the phone's real `active.cur` and nothing else. Deliberately reports `changed: true` even
    // when `cur` already equals `index` — the watch's tap stays *pending* until a `state` with
    // `exerciseIndex == index` arrives (section 2.4), so the command must always be followed by a
    // fresh higher `rev`. `duplicate` is reserved for an id already applied, never for this case.
    case COMMANDS.SELECT_EXERCISE: {
      const entries = S.active.entries
      const index = cmd?.args?.index
      if (!Number.isInteger(index)) return { changed: false, reason: REASON_INVALID }
      if (index < 0 || index >= entries.length) return { changed: false, reason: REASON_INVALID }
      S.active.cur = clampIndex(index, entries.length)
      return { changed: true, reason: null }
    }
    case COMMANDS.ADJUST_REST: {
      // Protocol §4: an adjustment aimed at a rest that has already ended is a no-op and is still
      // answered `applied` — the state is already what the user asked for.
      const delta = Math.round(Number(cmd?.args?.deltaSeconds))
      if (!Number.isFinite(delta) || delta === 0) return { changed: false, reason: REASON_INVALID }
      if (!ui?.addRest || !ui.timer) return { changed: false, reason: null, restartApplied: true }
      ui.addRest(delta)
      return { changed: false, reason: null, restartApplied: true }
    }
    case COMMANDS.SKIP_REST: {
      if (!ui?.stopRest || !ui.timer) return { changed: false, reason: null, restartApplied: true }
      ui.stopRest()
      return { changed: false, reason: null, restartApplied: true }
    }
    default:
      return { changed: false, reason: REASON_INVALID }
  }
}

/**
 * Ticks the set the watch is looking at and moves the marker on, exactly as the workout screen's
 * space bar does: the exercise in front of you is finished, so the marker goes to the next one
 * with work left first (`Workout.jsx` `onKey` → `nextOpenSet` → `focusUnit`), then the set is
 * ticked and the rest the set earned is started through `useUI.startRest`.
 */
function completeSet(S, ui) {
  const A = S.active
  const entries = A.entries
  const cur = clampIndex(A.cur, entries.length)
  const next = nextOpenSet(entries, cur)
  if (!next) return { changed: false, reason: REASON_INVALID }

  if (next.idx !== cur) A.cur = next.idx
  const entry = entries[next.idx]
  const sets = entry.sets
  const row = sets[next.i]
  if (!row) return { changed: false, reason: REASON_INVALID }
  if (row.done) return { changed: false, reason: REASON_INVALID }

  if (next.side && isSideSet(row)) sets[next.i] = toggleSide(row, next.side)
  else row.done = true
  sets[next.i].at = Date.now()
  if (sets[next.i].planSec != null) delete sets[next.i].planSec
  // Captured now, exactly as `toggle` does: the remembered best is only written at the finish, so
  // a weight corrected later is not credited as a record.
  if (sets.every(s => s.done)) entry.topW = bestWeightForEntry(entry) || null
  if (next.side && isSideSet(sets[next.i]) && !sets[next.i].done) {
    // One side of a unilateral row is ticked: nothing else in the flow has happened yet.
    return { changed: true, reason: null }
  }

  const units = supersetUnits(entries)
  const unit = unitOf(units, next.idx)
  const unitDone = unit.every(i => entries[i].sets.every(s => s.done))
  const nextUnit = unitDone ? nextUnfinishedUnit(entries, units, next.idx) : null
  const lastUnit = unitDone && !nextUnit
  // With finished exercises folding away, the marker moves on to what is left, the same advance
  // `toggle` makes when the unit it just closed is the one on screen.
  if (unitDone && nextUnit) A.cur = nextUnit[0]

  const restBeforeWarmup = !!nextUnit?.some(i => entries[i].sets.some(s => isWarmupRow(s) && !s.done))
  const setRest = { idx: next.idx, sec: pyramidRestFor(entry.target, entry.sets, next.i) }
  const restSec = restSecFor(entries, unit, S.restSec, setRest)
  const restAfter = warmupRestSecFor(entry, next.i, restSec)
  const startRest = () => {
    if (restAfter > 0 && ui?.startRest) ui.startRest(restAfter, next.idx, { forSet: next.i })
  }

  if (unitDone && ui?.stopRest) ui.stopRest()
  if (unit.length <= 1) {
    if (!restBeforeWarmup && restAfterSet({ unitDone, lastUnit })) startRest()
  } else {
    const step = supersetFlowStep(entries, unit, next.idx)
    if (step) {
      if (step.unitDone) {
        if (nextUnit?.length && !restBeforeWarmup) startRest()
      } else {
        if (step.nextIdx != null) A.cur = step.nextIdx
        if (step.roundDone) startRest()
      }
    }
  }

  return { changed: true, reason: null }
}

/**
 * The open set's weight, plus a kg delta.
 *
 * On an lb profile the stored number is in lb (openGym keeps a document in the profile's own unit),
 * so the value is converted to kg, the delta applied, and the result snapped back **on the
 * profile's own lattice** ([storedWeightFromKg]) — a `+0.4536 kg` command (the watch's 1 lb step)
 * adds exactly one pound, which a 0.5 kg snap used to round straight back to where it started. The
 * `weightOrigin` mark and the cascade to following inherited sets are what a typed weight does
 * (`Workout.jsx` `setField`).
 */
function adjustWeight(S, cmd) {
  const open = openSetOf(S)
  if (open.reason) return { changed: false, reason: open.reason }
  const deltaKg = Number(cmd?.args?.deltaKg)
  if (!Number.isFinite(deltaKg) || deltaKg === 0) return { changed: false, reason: REASON_INVALID }

  const unit = S.unit || 'kg'
  const storedBefore = Number.isFinite(Number(open.row.w)) ? Number(open.row.w) : 0
  // Task 2: the step is applied in the profile's unit, on that unit's own lattice.
  const kgBefore = kgOfStored(storedBefore, unit)
  const storedAfter =
    unit === 'lb'
      ? storedWeightFromKg(kgBefore + deltaKg, unit)
      : storedWeightFromKg(clampWeightKg(kgBefore + deltaKg), unit)
  if (storedAfter === storedBefore) return { changed: false, reason: REASON_INVALID }

  writeOpenWeight(open.ctx, open.i, storedAfter)
  return { changed: true, reason: null }
}

/**
 * An absolute weight in kg for the open set — the drag's release (plan section 2.3).
 *
 * Snapping to 0.5 and clamping to 0.0..500.0 is the phone's job by contract, so a value the watch
 * sends out of range is stored clamped rather than refused. The value already being the stored one
 * is still `applied`: it is what the user asked for, and the higher `rev` the ack path publishes is
 * what ends the watch's drag preview. Only a `kg` that is not a finite JSON number is `invalid`.
 *
 * Idempotent — the same frame applied twice leaves the same document, which is what makes the
 * watch's replay-on-reconnect safe.
 */
function setWeight(S, cmd) {
  const open = openSetOf(S)
  if (open.reason) return { changed: false, reason: open.reason }
  const kg = cmd?.args?.kg
  if (typeof kg !== 'number' || !Number.isFinite(kg)) return { changed: false, reason: REASON_INVALID }

  const unit = S.unit || 'kg'
  // Task 2: the snap is the profile's own. For a kg profile this is `clampWeightKg(kg)` exactly as
  // before; for an lb profile it lands the value on openGym's 0.5 lb lattice, which is what makes
  // the watch's 1 lb step survive the round trip.
  const storedAfter = storedWeightFromKg(kg, unit)
  writeOpenWeight(open.ctx, open.i, storedAfter)
  return { changed: true, reason: null }
}

/** The open set's reps, clamped to 1..99 (protocol section 4). */
function adjustReps(S, cmd) {
  const open = openSetOf(S)
  if (open.reason) return { changed: false, reason: open.reason }
  const delta = Number(cmd?.args?.delta)
  if (!Number.isFinite(delta) || delta === 0) return { changed: false, reason: REASON_INVALID }

  const before = Number.isFinite(Number(open.row.r)) ? Math.round(Number(open.row.r)) : 0
  const after = clampReps(before + delta)
  if (after === before) return { changed: false, reason: REASON_INVALID }
  open.row.r = after
  return { changed: true, reason: null }
}

/**
 * An absolute rep count for the open set — the reps drag's release (plan section 2.3). The same set
 * as `adjustReps`, through [openSetOf], clamped to 1..99 by the phone. A `reps` that is not an
 * integer is `invalid`; a value that is already stored is still `applied` (see [setWeight]).
 */
function setReps(S, cmd) {
  const open = openSetOf(S)
  if (open.reason) return { changed: false, reason: open.reason }
  const reps = cmd?.args?.reps
  if (!Number.isInteger(reps)) return { changed: false, reason: REASON_INVALID }
  open.row.r = clampReps(reps)
  return { changed: true, reason: null }
}
