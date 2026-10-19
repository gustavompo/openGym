// @vitest-environment happy-dom

// The watch's commands as the phone applies them (docs/protocol.md §4).
//
// What these tests are for: a command from the watch must land in the phone's own document and go
// through the phone's own rest timer — the same `update`/`persist` write and the same `useUI`
// actions the on-screen buttons use. A refused command must write nothing at all, so a rejected
// tap can never show up as a change in the document or in the sync log.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api.js', () => ({ api: vi.fn() }))
const { toast } = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('./useUI.js', () => ({ useUI: { getState: () => ({ toast }) } }))

import { useStore } from './useStore.js'

const KEY = 'gym_state_v1'

const entry = (id, sets, target = {}) => ({
  id,
  target: { id, sets: sets.length, reps: 8, weight: 0, ...target },
  rid: 'r1',
  sets,
})

const doc = () => ({
  unit: 'kg',
  restSec: 90,
  sessionSounds: true,
  routines: [],
  week: {},
  dayPlan: {},
  exWeights: {},
  workouts: [],
  active: {
    id: 'active-1',
    d: '2026-10-10',
    start: 1791666282530,
    routineIds: ['r1'],
    name: 'Full Body A',
    bw: null,
    cur: 0,
    workoutView: 'cards',
    entries: [
      entry('0043', [
        { w: 40, r: 8, done: false },
        { w: 42.5, r: 8, done: false },
      ]),
      entry('0025', [
        { w: 0, r: 8, done: false },
        { w: 0, r: 8, done: false },
      ]),
    ],
  },
})

const stored = () => JSON.parse(localStorage.getItem(KEY) || 'null')

let ui
const cmd = (name, args = {}) => ({ v: 1, type: 'command', id: 'c-1-1', name, baseRev: 1, issuedAt: 1, args })

const run = c => useStore.getState().applyWatchCommand(c, ui)

beforeEach(() => {
  localStorage.clear()
  useStore.setState({ S: doc(), user: null, ready: false })
  ui = { startRest: vi.fn(), addRest: vi.fn(), stopRest: vi.fn(), timer: { left: 80, total: 90, endsAt: 1791665234842 } }
})

describe('completeSet', () => {
  it('ticks the open set, stamps it and starts the rest the set earned', () => {
    const result = run(cmd('completeSet'))
    expect(result.applied).toBe(true)
    expect(ui.startRest).toHaveBeenCalledWith(90, 0, { forSet: 0 })

    const sets = stored().active.entries[0].sets
    expect(sets[0].done).toBe(true)
    expect(typeof sets[0].at).toBe('number')
    expect(sets[0].at).toBeGreaterThan(0)
    expect(sets[1].done).toBe(false)
  })

  it('ticks the next exercise and moves the marker when the current one is finished', () => {
    const S = doc()
    S.active.entries[0].sets.forEach((s, i) => { s.done = true; s.at = i + 1 })
    useStore.setState({ S })

    expect(run(cmd('completeSet')).applied).toBe(true)
    const after = stored().active
    expect(after.cur).toBe(1)
    expect(after.entries[1].sets[0].done).toBe(true)
  })

  it('starts no rest after the session\u2019s last set', () => {
    const S = doc()
    S.active.cur = 1
    S.active.entries[0].sets.forEach(s => { s.done = true })
    S.active.entries[1].sets[0].done = true
    useStore.setState({ S })

    expect(run(cmd('completeSet')).applied).toBe(true)
    expect(ui.startRest).not.toHaveBeenCalled()
  })

  it('is refused, writing nothing, when there is nothing left to tick', () => {
    const S = doc()
    S.active.entries.forEach(e => e.sets.forEach(s => { s.done = true }))
    useStore.setState({ S })

    expect(run(cmd('completeSet'))).toEqual({ applied: false, reason: 'invalid' })
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(ui.startRest).not.toHaveBeenCalled()
  })
})

describe('exercise navigation', () => {
  it('nextExercise moves the marker on, and the write is in the document', () => {
    expect(run(cmd('nextExercise'))).toEqual({ applied: true, reason: null })
    expect(stored().active.cur).toBe(1)
  })

  it('previousExercise moves it back', () => {
    const S = doc()
    S.active.cur = 1
    useStore.setState({ S })
    expect(run(cmd('previousExercise'))).toEqual({ applied: true, reason: null })
    expect(stored().active.cur).toBe(0)
  })

  it('is refused at the first and at the last exercise — and writes nothing', () => {
    expect(run(cmd('previousExercise'))).toEqual({ applied: false, reason: 'invalid' })
    expect(localStorage.getItem(KEY)).toBeNull()

    const S = doc()
    S.active.cur = 1
    useStore.setState({ S })
    expect(run(cmd('nextExercise'))).toEqual({ applied: false, reason: 'invalid' })
    expect(localStorage.getItem(KEY)).toBeNull()
  })
})

describe('weight and reps', () => {
  it('adjustWeight moves the open set in kg steps and marks the edit as manual', () => {
    expect(run(cmd('adjustWeight', { deltaKg: 0.5 }))).toEqual({ applied: true, reason: null })
    const row = stored().active.entries[0].sets[0]
    expect(row.w).toBe(40.5)
    expect(row.weightOrigin).toBe('manual')
  })

  it('adjustWeight cascades to the following inherited sets, as a typed weight does', () => {
    run(cmd('adjustWeight', { deltaKg: 2.5 }))
    const sets = stored().active.entries[0].sets
    expect(sets[0].w).toBe(42.5)
    expect(sets[1].w).toBe(42.5)
  })

  it('adjustWeight is refused at the 500 kg ceiling rather than writing', () => {
    const S = doc()
    S.active.entries[0].sets[0].w = 500
    useStore.setState({ S })
    expect(run(cmd('adjustWeight', { deltaKg: 0.5 }))).toEqual({ applied: false, reason: 'invalid' })
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('adjustWeight converts on an lb profile instead of writing 0.5 lb for 0.5 kg', () => {
    const S = doc()
    S.unit = 'lb'
    S.active.entries[0].sets[0].w = 100
    useStore.setState({ S })
    run(cmd('adjustWeight', { deltaKg: 0.5 }))
    // Task 2 UPDATED THIS TEST'S EXPECTATION. It used to assert 101.5, which is what came out of
    // snapping the value to the watch's 0.5 kg grid (45.36 -> 45.5 -> +0.5 = 46 kg -> 101.5 lb).
    // The snap now happens on the PROFILE'S OWN lattice (0.5 lb, openGym's `convertWeight`), so a
    // 0.5 kg delta on a 100 lb set lands on 101.0 lb — the honest conversion, not a kg-shaped one.
    expect(stored().active.entries[0].sets[0].w).toBe(101)
  })

  it('a one-pound step survives the round trip on an lb profile', () => {
    // What the watch actually sends for one detent on an lb profile: `WeightUnit.toKg(1.0)`.
    const S = doc()
    S.unit = 'lb'
    S.active.entries[0].sets[0].w = 100
    useStore.setState({ S })
    expect(run(cmd('adjustWeight', { deltaKg: 1 / 2.2046226218 }))).toEqual({ applied: true, reason: null })
    // Exactly one pound. Under the old 0.5 kg snap this was 100 -> 45.36 kg -> 45.5 -> 101.5 lb,
    // i.e. the step the user took was not the step they got.
    expect(stored().active.entries[0].sets[0].w).toBe(101)

    // And apply it repeatedly: the spinner walks the pound lattice, one pound at a time.
    for (let i = 0; i < 3; i++) run(cmd('adjustWeight', { deltaKg: 1 / 2.2046226218 }))
    expect(stored().active.entries[0].sets[0].w).toBe(104)
  })

  it('adjustReps moves the open set and clamps to 1..99', () => {
    expect(run(cmd('adjustReps', { delta: 1 }))).toEqual({ applied: true, reason: null })
    expect(stored().active.entries[0].sets[0].r).toBe(9)

    localStorage.clear()
    const S = doc()
    S.active.entries[0].sets[0].r = 99
    useStore.setState({ S })
    expect(run(cmd('adjustReps', { delta: 1 }))).toEqual({ applied: false, reason: 'invalid' })
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('is refused for a malformed delta', () => {
    expect(run(cmd('adjustWeight', {}))).toEqual({ applied: false, reason: 'invalid' })
    expect(run(cmd('adjustReps', { delta: 0 }))).toEqual({ applied: false, reason: 'invalid' })
    expect(localStorage.getItem(KEY)).toBeNull()
  })
})

describe('rest control', () => {
  it('adjustRest goes through the rest bar\u2019s own addRest', () => {
    expect(run(cmd('adjustRest', { deltaSeconds: 15 }))).toEqual({ applied: true, reason: null })
    expect(ui.addRest).toHaveBeenCalledWith(15)
  })

  it('an adjustment with no rest running is a no-op that is still applied (§4)', () => {
    ui.timer = null
    expect(run(cmd('adjustRest', { deltaSeconds: 15 }))).toEqual({ applied: true, reason: null })
    expect(ui.addRest).not.toHaveBeenCalled()
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('skipRest goes through the rest bar\u2019s own stopRest', () => {
    expect(run(cmd('skipRest'))).toEqual({ applied: true, reason: null })
    expect(ui.stopRest).toHaveBeenCalled()
  })

  it('skipRest with no rest running is a no-op that is still applied', () => {
    ui.timer = null
    expect(run(cmd('skipRest'))).toEqual({ applied: true, reason: null })
    expect(ui.stopRest).not.toHaveBeenCalled()
  })
})

describe('refusals that do not touch the document', () => {
  it('no session running is noWorkout', () => {
    useStore.setState({ S: { ...doc(), active: null } })
    expect(run(cmd('completeSet'))).toEqual({ applied: false, reason: 'noWorkout' })
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('an unknown command name is invalid', () => {
    expect(run(cmd('doSomethingElse'))).toEqual({ applied: false, reason: 'invalid' })
    expect(localStorage.getItem(KEY)).toBeNull()
  })
})
