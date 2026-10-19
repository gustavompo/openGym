import { describe, expect, it } from 'vitest'
import { currentSetIndex, openSetIndex, projectRest, projectState, projectWorkout, projectionKey, unitOf } from './wear-projection.js'
// openGym's own constant (lib/units.js, not exported), spelled here so the test does not depend on
// the production module exporting it.
const LB_PER_KG = 2.2046226218

// A document shaped like the one captured from the running phone (`docs/notes/artifacts/09/`):
// exercise 0043 finished, 0025 untouched, 90 s global rest, no history yet.
const doc = (over = {}) => ({
  unit: 'kg',
  restSec: 90,
  restPauseSec: 15,
  exWeights: {},
  workouts: [],
  routines: [],
  week: {},
  dayPlan: {},
  active: {
    id: 'mv2vufc29liyv',
    d: '2026-10-10',
    start: 1791666282530,
    routineIds: ['mv2vtt261km42'],
    name: 'Full Body A',
    bw: null,
    cur: 0,
    workoutView: 'cards',
    entries: [
      {
        id: '0043',
        target: { id: '0043', sets: 3, reps: 8, weight: 0 },
        rid: 'mv2vtt261km42',
        sets: [
          { w: 40, r: 8, done: true, at: 1791666357250 },
          { w: 42.5, r: 8, done: true, at: 1791666454425 },
          { w: 45, r: 8, done: true, at: 1791666507407 },
        ],
      },
      {
        id: '0025',
        target: { id: '0025', sets: 3, reps: 8, weight: 0, restSec: 60 },
        rid: 'mv2vtt261km42',
        sets: [
          { w: 0, r: 8, done: false },
          { w: 0, r: 8, done: false },
          { w: 0, r: 8, done: false },
        ],
      },
    ],
  },
  ...over,
})

const at = (S, cur) => ({ ...S, active: { ...S.active, cur } })

describe('the workout projection (protocol §3.1)', () => {
  it('reads the entry the marker is on, with "Set 3/3" for a finished exercise', () => {
    const w = projectWorkout(doc())
    expect(w.id).toBe('mv2vufc29liyv')
    expect(w.name).toBe('Full Body A')
    expect(w.exerciseIndex).toBe(0)
    expect(w.exerciseCount).toBe(2)
    expect(w.setIndex).toBe(3)
    expect(w.setCount).toBe(3)
    // Every set is done, so the displayed values are the last set's — as the watch's own
    // `toWorkoutState` reads `open?.weightKg ?: lastKnown?.weightKg`.
    expect(w.weightKg).toBe(45)
    expect(w.reps).toBe(8)
    expect(typeof w.exerciseName).toBe('string')
    expect(w.exerciseName.length).toBeGreaterThan(0)
  })

  it('counts done sets up: "Set 1/3" before anything is ticked', () => {
    const w = projectWorkout(at(doc(), 1))
    expect(w.exerciseIndex).toBe(1)
    expect(w.setIndex).toBe(1)
    expect(w.setCount).toBe(3)
    expect(w.weightKg).toBe(0)
    expect(w.reps).toBe(8)
    // Nothing done in this exercise and no history: no previous-set hint to show.
    expect(w.previousWeightKg).toBeNull()
    expect(w.previousReps).toBeNull()
  })

  it('shows the last set done in the session as the previous-set hint, before history', () => {
    const S = at(doc(), 1)
    S.active.entries[1].sets[0] = { w: 12.5, r: 9, done: true, at: 1 }
    const w = projectWorkout(S)
    expect(w.setIndex).toBe(2)
    expect(w.previousWeightKg).toBe(12.5)
    expect(w.previousReps).toBe(9)
  })

  it('falls back to the last session the exercise was trained in', () => {
    const S = doc({
      workouts: [
        { id: 'w1', d: '2026-10-08', entries: [{ id: '0025', rid: 'mv2vtt261km42', sets: [{ w: 9, r: 12, done: true }] }] },
      ],
    })
    const w = projectWorkout(at(S, 1))
    expect(w.previousWeightKg).toBe(9)
    expect(w.previousReps).toBe(12)
  })

  // --- task 2: the unit on the frame -----------------------------------------------------------

  it('carries the profile unit, and defaults to kg for anything unknown', () => {
    expect(projectWorkout(doc()).unit).toBe('kg')
    expect(projectWorkout(doc({ unit: 'lb' })).unit).toBe('lb')
    expect(projectWorkout(doc({ unit: undefined })).unit).toBe('kg')
    expect(projectWorkout(doc({ unit: 'LB' })).unit).toBe('kg')
    expect(projectWorkout(doc({ unit: 'pounds' })).unit).toBe('kg')
    expect(unitOf({})).toBe('kg')
  })

  it('sends an lb document\'s stored pounds as kilograms', () => {
    // The document holds the profile's own unit: 45 here is 45 lb, and the wire promises kg.
    const w = projectWorkout(doc({ unit: 'lb' }))
    expect(w.unit).toBe('lb')
    expect(w.weightKg).toBeCloseTo(45 / LB_PER_KG, 10)
    expect(w.weightKg).not.toBe(45) // sending the raw number would be a 2.2x error
  })

  it('converts the previous-set hint too', () => {
    const S = at(doc({ unit: 'lb' }), 1)
    S.active.entries[1].sets[0] = { w: 110, r: 9, done: true, at: 1 }
    const w = projectWorkout(S)
    expect(w.previousWeightKg).toBeCloseTo(110 / LB_PER_KG, 10)
  })

  it('leaves a kg document\'s weights exactly as they were', () => {
    // The no-op proof: for a kg profile the numbers are the stored ones, bit for bit.
    const w = projectWorkout(doc())
    expect(w.weightKg).toBe(45)
    const S = at(doc(), 1)
    S.active.entries[1].sets[0] = { w: 12.5, r: 9, done: true, at: 1 }
    expect(projectWorkout(S).previousWeightKg).toBe(12.5)
  })

  it('a record whose `w` is missing is still 0, not a conversion artefact', () => {
    const S = doc({ unit: 'lb' })
    S.active.entries[0].sets = [{ r: 8, done: false }]
    expect(projectWorkout(S).weightKg).toBe(0)
  })

  it('is null when no session is running — not an error, and not unreachable', () => {
    expect(projectWorkout({ active: null })).toBeNull()
    expect(projectWorkout({ active: { entries: [] } })).toBeNull()
    expect(projectWorkout(undefined)).toBeNull()
  })

  it('clamps a marker left past the last exercise', () => {
    const w = projectWorkout(at(doc(), 99))
    expect(w.exerciseIndex).toBe(1)
  })
})

describe('the rest projection', () => {
  const timer = { left: 75, total: 90, endsAt: 1791665234842 }

  it('carries an absolute deadline, never a countdown', () => {
    const rest = projectRest(doc(), timer, 1791665144842)
    expect(rest.running).toBe(true)
    expect(rest.endsAt).toBe(1791665234842)
    expect(rest.total).toBe(90)
    expect(rest.paused).toBe(false)
    expect(rest.left).toBeNull()
  })

  it('is not running once the deadline has passed, and says nothing about a countdown', () => {
    const rest = projectRest(doc(), timer, 1791665234843)
    expect(rest.running).toBe(false)
    expect(rest.endsAt).toBeNull()
    expect(rest.left).toBeNull()
  })

  it('is not running when the rest shows Ready, even though a timer object remains', () => {
    const rest = projectRest(doc(), { ...timer, ready: true, left: 0 }, 1791665144842)
    expect(rest.running).toBe(false)
    expect(rest.endsAt).toBeNull()
  })

  it('carries `left` and no deadline while paused, so the watch cannot resume on its own', () => {
    const rest = projectRest(doc(), { ...timer, paused: true, left: 42 }, 1791665144842)
    expect(rest.paused).toBe(true)
    expect(rest.running).toBe(false)
    expect(rest.endsAt).toBeNull()
    expect(rest.left).toBe(42)
  })

  it('offers the current exercise\u2019s own rest as the idle rest', () => {
    // 0025 carries restSec: 60 on its target; the 90 s global only applies where an exercise has none.
    expect(projectRest(at(doc(), 1), null, 0).restWhenIdle).toBe(60)
    expect(projectRest(doc(), null, 0).restWhenIdle).toBe(90)
  })

  it('sends no rest at all for a session that is not running', () => {
    const rest = projectRest({ active: null, restSec: 90 }, null, 0)
    expect(rest.running).toBe(false)
    expect(rest.paused).toBe(false)
    expect(rest.total).toBe(90)
  })
})

describe('projection identity', () => {
  it('is unchanged by the countdown alone, so a ticking rest cannot invalidate a command', () => {
    const a = projectState(doc(), { left: 90, total: 90, endsAt: 1000 }, 0)
    const b = projectState(doc(), { left: 30, total: 90, endsAt: 1000 }, 0)
    expect(projectionKey(a)).toBe(projectionKey(b))
  })

  it('changes when the document does', () => {
    const S = doc()
    const before = projectState(S, null, 0)
    S.active.cur = 1
    expect(projectionKey(projectState(S, null, 0))).not.toBe(projectionKey(before))
  })
})

describe('set-index helpers', () => {
  it('finds the first unticked set, or -1 when the exercise is finished', () => {
    expect(openSetIndex([{ done: true }, { done: false }])).toBe(1)
    expect(openSetIndex([{ done: true }])).toBe(-1)
    expect(openSetIndex([])).toBe(-1)
    expect(openSetIndex(undefined)).toBe(-1)
  })

  it('clamps so a finished exercise never reads "Set 4/3"', () => {
    expect(currentSetIndex([{ done: true }, { done: true }])).toBe(2)
    expect(currentSetIndex([{ done: true }, { done: false }])).toBe(2)
    expect(currentSetIndex([])).toBe(0)
  })
})

// --- M7.1: the two fields the workout page's list needs (plan 19 §2.1) -------------------------
describe('workout.startedAt (plan §2.1 rule 5)', () => {
  it('is active.start in epoch millis when the session really started', () => {
    expect(projectWorkout(doc()).startedAt).toBe(1791666282530)
  })

  it('is null, never 0, when active.start is missing — epoch 0 is a 20 491-day timer', () => {
    const S = doc()
    delete S.active.start
    expect(projectWorkout(S).startedAt).toBeNull()
  })

  it('is null for 0, for garbage and for a negative start', () => {
    // `components/TabBar.jsx` gates the elapsed readout on `start > 0`, so 0 means "not started".
    expect(projectWorkout({ ...doc(), active: { ...doc().active, start: 0 } }).startedAt).toBeNull()
    expect(projectWorkout({ ...doc(), active: { ...doc().active, start: 'not a time' } }).startedAt).toBeNull()
    expect(projectWorkout({ ...doc(), active: { ...doc().active, start: -5 } }).startedAt).toBeNull()
  })
})

describe('workout.entries (plan §2.1 rules 1-4)', () => {
  it('lists every exercise in order, length == exerciseCount, index == position', () => {
    const w = projectWorkout(at(doc(), 1))
    expect(w.entries).toHaveLength(w.exerciseCount)
    expect(w.entries.map(e => e.index)).toEqual([0, 1])
    // Same resolver as `exerciseName`, so the row and the header can never disagree (rule 3).
    expect(w.entries[0].name).toBe(projectWorkout(at(doc(), 0)).exerciseName)
    expect(w.entries[1].name).toBe(w.exerciseName)
  })

  it('carries the progress: setsDone is the count of done sets, setsTotal is sets.length', () => {
    const w = projectWorkout(doc())
    expect(w.entries[0]).toMatchObject({ index: 0, setsDone: 3, setsTotal: 3 })
    expect(w.entries[1]).toMatchObject({ index: 1, setsDone: 0, setsTotal: 3 })
  })

  it('uses the same resolver as exerciseName, so a row cannot disagree with the header', () => {
    const S = at(doc(), 1)
    const w = projectWorkout(S)
    expect(w.entries[1].name).toBe(w.exerciseName)
    // A name is never empty, even for an id the catalogue does not know.
    const unknown = doc()
    unknown.active.entries[1].id = 'zzzz'
    expect(projectWorkout(unknown).entries[1].name).toBeTruthy()
  })

  it('keeps 0 <= setsDone <= setsTotal, and allows a zero-set exercise', () => {
    const S = doc()
    S.active.entries[0].sets = []
    S.active.entries[1].sets = [{ w: 0, r: 8, done: true }, { w: 0, r: 8, done: true }]
    const w = projectWorkout(S)
    expect(w.entries[0]).toMatchObject({ setsDone: 0, setsTotal: 0 })
    expect(w.entries[1]).toMatchObject({ setsDone: 2, setsTotal: 2 })
    for (const e of w.entries) {
      expect(e.setsDone).toBeGreaterThanOrEqual(0)
      expect(e.setsDone).toBeLessThanOrEqual(e.setsTotal)
    }
  })

  it('is what the frame carries, so the watch never has to ask for the list separately', () => {
    const projection = projectState(doc(), null, 0)
    expect(projection.workout.entries).toHaveLength(2)
    expect(projection.workout.startedAt).toBe(1791666282530)
  })
})
