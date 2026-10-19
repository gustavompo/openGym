import { describe, expect, it, vi } from 'vitest'
import { applyWatchCommandTo, clampWeightKg, storedWeightFromKg, LB_STEP, LB_PER_KG } from './wear-commands.js'
import { COMMANDS, REASON_INVALID, REASON_NO_WORKOUT } from './wear-frames.js'
import { convertWeight } from './units.js'

// M7.1: the three commands the workout page and the drag wheel add, at the level of the phone's own
// document. The apply path is `store/useStore.js` `applyWatchCommand` -> `applyWatchCommandTo`, so
// these are the rules the `state` frame the watch renders is derived from.
//
// Contract: docs/notes/19-workout-page-wheel-plan.md §2.2 (`selectExercise`) and §2.3
// (`setWeight`/`setReps`).

const set = (w, r, done = false) => ({ w, r, done })

const entry = (id, sets) => ({ id, target: { id, sets: sets.length, reps: 8, weight: 0 }, rid: 'r1', sets })

/** Two exercises; the first has one done set, so the "open set" is `sets[1]`, not `sets[0]`. */
const doc = () => ({
  unit: 'kg',
  restSec: 90,
  active: {
    id: 'active-1',
    name: 'Full Body A',
    start: 1791666282530,
    cur: 0,
    entries: [entry('0043', [set(40, 8, true), set(40, 8), set(40, 8)]), entry('0025', [set(20, 10), set(20, 10)])],
  },
})

const cmd = (name, args = {}) => ({ v: 1, type: 'command', id: 'c-1-1', name, baseRev: 7, issuedAt: 1, args })

const apply = (S, name, args, ui = {}) => applyWatchCommandTo(S, ui, cmd(name, args))

describe('selectExercise (plan §2.2)', () => {
  it('writes the phone’s real active.cur, and nothing else', () => {
    const S = doc()
    const before = JSON.stringify(S.active.entries)
    const r = apply(S, COMMANDS.SELECT_EXERCISE, { index: 1 })
    expect(r).toEqual({ changed: true, reason: null })
    expect(S.active.cur).toBe(1)
    // It must not touch sets and must not start, stop or alter a rest.
    expect(JSON.stringify(S.active.entries)).toBe(before)
  })

  it('is applied even when cur already equals index — the watch’s tap is pending until it sees the state', () => {
    // Plan §2.2: `applied` must always be followed by a fresh `state` with a higher `rev`, so this
    // deliberately reports a write rather than a no-op. `duplicate` is for a replayed id only.
    const S = doc()
    const r = apply(S, COMMANDS.SELECT_EXERCISE, { index: 0 })
    expect(r.changed).toBe(true)
    expect(r.reason).toBeNull()
    expect(S.active.cur).toBe(0)
  })

  it('refuses an out-of-range index as invalid, terminal — not clamped into range', () => {
    for (const index of [2, 99, -1]) {
      const S = doc()
      expect(apply(S, COMMANDS.SELECT_EXERCISE, { index })).toEqual({ changed: false, reason: REASON_INVALID })
      expect(S.active.cur).toBe(0)
    }
  })

  it('refuses a non-integer index as invalid', () => {
    for (const index of [1.5, '1', null, undefined, NaN, {}]) {
      const S = doc()
      expect(apply(S, COMMANDS.SELECT_EXERCISE, { index })).toEqual({ changed: false, reason: REASON_INVALID })
    }
  })

  it('refuses with noWorkout when no session is running', () => {
    const S = { ...doc(), active: null }
    expect(apply(S, COMMANDS.SELECT_EXERCISE, { index: 0 })).toEqual({ changed: false, reason: REASON_NO_WORKOUT })
  })

  it('never calls into the rest timer', () => {
    const stopRest = vi.fn()
    const addRest = vi.fn()
    const S = doc()
    apply(S, COMMANDS.SELECT_EXERCISE, { index: 1 }, { stopRest, addRest, timer: { left: 10, total: 90 } })
    expect(stopRest).not.toHaveBeenCalled()
    expect(addRest).not.toHaveBeenCalled()
  })
})

describe('setWeight (plan §2.3)', () => {
  it('targets exactly the set adjustWeight targets — the open set of the current exercise', () => {
    const a = doc()
    const b = doc()
    apply(a, COMMANDS.ADJUST_WEIGHT, { deltaKg: 2.5 })
    apply(b, COMMANDS.SET_WEIGHT, { kg: 42.5 })
    // The strongest statement of "same code path": the two documents are byte-identical, so a drag
    // and a crown step cannot have edited different sets.
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(a.active.entries[0].sets[1].w).toBe(42.5)
    expect(a.active.entries[0].sets[0].w).toBe(40) // the done set is untouched
  })

  it('snaps to 0.5 and clamps to 0..500 — the phone’s job, not the watch’s', () => {
    const cases = [
      [52.5, 52.5],
      [52.51, 52.5],
      [52.6, 52.5],
      [52.75, 53], // 52.75/0.5 = 105.5 -> round half up = 106
      [-3, 0],
      [501, 500],
      [1e9, 500],
    ]
    for (const [kg, expected] of cases) {
      const S = doc()
      apply(S, COMMANDS.SET_WEIGHT, { kg })
      expect(S.active.entries[0].sets[1].w).toBe(expected)
    }
  })

  it('marks the set manual and cascades, exactly as a typed weight does', () => {
    const S = doc()
    apply(S, COMMANDS.SET_WEIGHT, { kg: 60 })
    const sets = S.active.entries[0].sets
    expect(sets[1].w).toBe(60)
    expect(sets[1].weightOrigin).toBeTruthy()
    // The following set inherits, the same as `adjustWeight` leaves it: the two are one code path.
    const viaDelta = doc()
    apply(viaDelta, COMMANDS.ADJUST_WEIGHT, { deltaKg: 20 })
    expect(JSON.stringify(S)).toBe(JSON.stringify(viaDelta))
  })

  it('is idempotent: applying the same frame twice is the same document', () => {
    const once = doc()
    apply(once, COMMANDS.SET_WEIGHT, { kg: 55 })
    const twice = doc()
    apply(twice, COMMANDS.SET_WEIGHT, { kg: 55 })
    apply(twice, COMMANDS.SET_WEIGHT, { kg: 55 })
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
  })

  it('refuses a non-finite or non-numeric kg as invalid', () => {
    for (const kg of [NaN, Infinity, -Infinity, null, undefined, '52.5', {}, []]) {
      const S = doc()
      const r = apply(S, COMMANDS.SET_WEIGHT, { kg })
      expect(r).toEqual({ changed: false, reason: REASON_INVALID })
      expect(S.active.entries[0].sets[1].w).toBe(40)
    }
  })

  it('refuses with noWorkout, and with invalid when every set is done', () => {
    expect(apply({ ...doc(), active: null }, COMMANDS.SET_WEIGHT, { kg: 50 })).toEqual({
      changed: false,
      reason: REASON_NO_WORKOUT,
    })
    const S = doc()
    S.active.entries[0].sets = [set(40, 8, true)]
    expect(apply(S, COMMANDS.SET_WEIGHT, { kg: 50 })).toEqual({ changed: false, reason: REASON_INVALID })
  })

  it('is converted on an lb profile, the same way the delta path converts', () => {
    const S = { ...doc(), unit: 'lb' }
    apply(S, COMMANDS.SET_WEIGHT, { kg: 45 })
    // The document stays in the profile's own unit — 45 kg stored as its lb equivalent, snapped in
    // kg first, through the same `clampWeightKg` + `convertWeight` pair `adjustWeight` uses.
    const stored = convertWeight(clampWeightKg(45), 'kg', 'lb')
    expect(S.active.entries[0].sets[1].w).toBe(stored)
    expect(S.active.entries[0].sets[1].w).not.toBe(45) // writing kg into an lb document is a 2.2x error
    expect(S.active.entries[0].sets[1].weightOrigin).toBeTruthy()
    expect(S.active.entries[0].sets[2].w).toBe(stored) // the cascade follows in lb too
  })
})

describe('the weight lattice follows the profile unit (task 2)', () => {
  it('snaps to a half pound on an lb profile, not to a half kilogram', () => {
    // 1 lb = 0.4536 kg; a 0.5 kg snap would move it back to where it started and the command would
    // be refused (the `if (storedAfter === storedBefore)` guard would fire).
    for (const [kg, expected] of [
      [45, 99], // 45 kg -> 99.208 lb -> 99.0
      [45.4, 100], // 100.1 lb -> 100.0
      [45.359237, 100], // exactly 100 lb
      [0, 0],
      [1000, 1102], // clamped to 500 kg -> 1102.31 lb -> 1102.0
    ]) {
      expect(storedWeightFromKg(kg, 'lb')).toBe(expected)
    }
  })

  it('is unchanged for a kg profile — the same 0.5 kg snap as before', () => {
    for (const [kg, expected] of [
      [52.5, 52.5],
      [52.51, 52.5],
      [52.75, 53],
      [-3, 0],
      [501, 500],
      [NaN, 0],
    ]) {
      expect(storedWeightFromKg(kg, 'kg')).toBe(expected)
      expect(storedWeightFromKg(kg)).toBe(expected) // the default argument is kg
    }
  })

  it('defaults an unknown unit to the kg lattice', () => {
    for (const unit of ['', 'LB', 'pounds', undefined, null, 7]) {
      expect(storedWeightFromKg(52.6, unit)).toBe(52.5)
    }
  })

  it('a pound step applied twice is two pounds, on an lb document', () => {
    const S = { ...doc(), unit: 'lb' }
    S.active.entries[0].sets = [set(100, 8), set(100, 8), set(100, 8)]
    const onePound = 1 / LB_PER_KG
    // The (magnitude of the) step the watch sends for one detent on an lb profile.
    expect(apply(S, COMMANDS.ADJUST_WEIGHT, { deltaKg: onePound })).toEqual({ changed: true, reason: null })
    expect(S.active.entries[0].sets[0].w).toBe(101)
    expect(apply(S, COMMANDS.ADJUST_WEIGHT, { deltaKg: onePound })).toEqual({ changed: true, reason: null })
    expect(S.active.entries[0].sets[0].w).toBe(102)
    // Half a pound is still representable: openGym's own lb lattice is 0.5.
    expect(LB_STEP).toBe(0.5)
  })

  it('a drag release in kg lands on the pound the watch showeds equivalent of', () => {
    // What `setWeight` receives from an lb watch for a displayed 112.5 lb.
    const S = { ...doc(), unit: 'lb' }
    S.active.entries[0].sets = [set(100, 8), set(100, 8), set(100, 8)]
    apply(S, COMMANDS.SET_WEIGHT, { kg: 112.5 / LB_PER_KG })
    expect(S.active.entries[0].sets[1].w).toBe(112.5)
  })

  it('refuses nothing that is a real pound step at the top of the range', () => {
    const S = { ...doc(), unit: 'lb' }
    S.active.entries[0].sets = [set(1102, 8), set(1102, 8), set(1102, 8)]
    // 1102 lb is the last displayable value; one more step is out of range and must be a refusal,
    // not a silent write.
    expect(apply(S, COMMANDS.ADJUST_WEIGHT, { deltaKg: 1 / LB_PER_KG })).toEqual({
      changed: false,
      reason: REASON_INVALID,
    })
    expect(S.active.entries[0].sets[0].w).toBe(1102)
  })
})

describe('setReps (plan §2.3)', () => {
  it('targets the same set as adjustReps and clamps to 1..99', () => {
    const a = doc()
    const b = doc()
    apply(a, COMMANDS.ADJUST_REPS, { delta: 4 })
    apply(b, COMMANDS.SET_REPS, { reps: 12 })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(a.active.entries[0].sets[1].r).toBe(12)

    for (const [reps, expected] of [[0, 1], [-4, 1], [1000, 99], [1, 1], [99, 99]]) {
      const S = doc()
      apply(S, COMMANDS.SET_REPS, { reps })
      expect(S.active.entries[0].sets[1].r).toBe(expected)
    }
  })

  it('refuses a non-integer reps as invalid', () => {
    for (const reps of [12.5, '12', null, undefined, NaN, Infinity]) {
      const S = doc()
      expect(apply(S, COMMANDS.SET_REPS, { reps })).toEqual({ changed: false, reason: REASON_INVALID })
      expect(S.active.entries[0].sets[1].r).toBe(8)
    }
  })

  it('is idempotent and leaves the done set alone', () => {
    const S = doc()
    apply(S, COMMANDS.SET_REPS, { reps: 11 })
    apply(S, COMMANDS.SET_REPS, { reps: 11 })
    expect(S.active.entries[0].sets[1].r).toBe(11)
    expect(S.active.entries[0].sets[0].r).toBe(8)
  })
})

describe('the two new absolute commands are not baseRev-gated', () => {
  it('has no stale gate in the apply path, so a late delivery is still correct', () => {
    // `onCommand` (lib/wear-link.js) applies the `stale` gate only to `RELATIVE_COMMANDS`; this
    // asserts the apply path itself never looks at baseRev, whatever it says.
    for (const baseRev of [0, 1, 7, 999]) {
      const S = doc()
      const r = applyWatchCommandTo(S, {}, { ...cmd(COMMANDS.SELECT_EXERCISE, { index: 1 }), baseRev })
      expect(r.changed).toBe(true)
    }
  })
})
