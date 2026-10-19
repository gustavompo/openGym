// @vitest-environment happy-dom

// The `rev` epoch across a phone-side restart (docs/protocol.md §5.2,
// docs/notes/18-rev-restart-fix.md).
//
// What these tests are for: the watch discards a `state` whose `rev` is not higher than the last one
// it accepted, and only a phone `hello` resets that mark — so anything that restarts the phone's
// `rev` while the link stays up makes the watch deaf in that direction alone. A page load does
// restart the JS context, and the link does not. The watch's half of the rule is transcribed below
// as [watchReceiveGate] so the assertions are about the two implementations agreeing, not about one
// module's own idea of correctness.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({ sent: [], listeners: {} }))

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'android' },
  registerPlugin: () => ({
    addListener: (name, cb) => {
      bridge.listeners[name] = cb
      return Promise.resolve()
    },
    start: () => Promise.resolve({ listening: true }),
    send: ({ frame }) => {
      bridge.sent.push(frame)
      return Promise.resolve({ sent: false, datalayer: false, cached: true })
    },
    session: () => Promise.resolve({ started: true, running: true }),
  }),
}))

/**
 * The watch's receive rule, transcribed from `TransportWorkoutRepository` (`onPhoneHello` /
 * `onState`): a new phone `hello` resets the high-water mark to -1, and every `state` whose `rev` is
 * not strictly higher than it is dropped. A gate that accepted everything would make this test pass
 * against the broken phone, so it is written out rather than stubbed away.
 */
function watchReceiveGate() {
  let highWaterRev = -1
  let snapshot = null
  let dropped = 0
  return {
    deliver(text) {
      const frame = JSON.parse(text)
      if (frame.type === 'hello' && frame.role === 'phone') {
        highWaterRev = -1
        return
      }
      if (frame.type !== 'state') return
      if (frame.rev <= highWaterRev) {
        dropped += 1
        return
      }
      highWaterRev = frame.rev
      snapshot = frame
    },
    get snapshot() {
      return snapshot
    },
    get highWaterRev() {
      return highWaterRev
    },
    get dropped() {
      return dropped
    },
    /** `WorkoutState.isResting` -> `destinationFor`: the rest screen while the clock has time left. */
    get isResting() {
      const rest = snapshot?.rest
      if (!rest?.running) return false
      if (rest.paused) return (rest.left ?? 0) > 0
      return rest.endsAt != null && rest.endsAt > Date.now()
    },
  }
}

const entry = (id, sets) => ({ id, target: { id, sets: sets.length, reps: 8, weight: 0 }, rid: 'r1', sets })

const doc = () => ({
  unit: 'kg',
  restSec: 90,
  routines: [],
  week: {},
  dayPlan: {},
  exWeights: {},
  workouts: [],
  active: {
    id: 'active-1',
    d: '2026-10-11',
    start: 1791666282530,
    routineIds: ['r1'],
    name: 'Full Body A',
    bw: null,
    cur: 0,
    workoutView: 'cards',
    entries: [entry('0043', [{ w: 40, r: 8, done: true }, { w: 40, r: 8, done: false }]), entry('0025', [{ w: 20, r: 10, done: false }])],
  },
})

/** A running rest, as `useUI` holds it and as `gym_rest` restores it on a reload. */
const runningRest = () => ({ left: 80, total: 90, endsAt: Date.now() + 80_000, forIdx: 0, forSet: 0 })

/**
 * One JS context: everything the page imports, from a registry the reload below can throw away.
 * `started` distinguishes "the app is booting" (link started, `hello` announced) from a context that
 * only publishes — the phone's own store writes do that too, and they must not depend on the link.
 */
async function jsContext({ start = true } = {}) {
  const link = await import('./wear-link.js')
  const { useStore } = await import('../store/useStore.js')
  const { useUI } = await import('../store/useUI.js')
  return { link, useStore, useUI, start }
}

async function boot({ rest = null, cur = 0 } = {}) {
  const ctx = await jsContext()
  ctx.useStore.setState({ S: { ...doc(), active: { ...doc().active, cur } }, user: null, ready: false })
  ctx.useUI.setState({ timer: rest })
  await ctx.link.startWearLink()
  return ctx
}

/** The watch consumes everything the phone has sent since [from]. */
function drain(gate, from = 0) {
  for (const frame of bridge.sent.slice(from)) gate.deliver(frame)
  return bridge.sent.length
}

/**
 * Hands the phone one inbound frame, the way the Capacitor plugin's `frame` listener does, and lets
 * the async `onCommand` chain (ack -> publish) run to completion.
 */
async function deliver(frame) {
  bridge.listeners.frame({ text: JSON.stringify(frame) })
  await new Promise(resolve => setTimeout(resolve, 0))
}

const command = (name, id, args, baseRev) => ({ v: 1, type: 'command', id, name, baseRev, issuedAt: 1, args })

const framesSent = () => bridge.sent.map(f => JSON.parse(f))

const lastState = () => framesSent().filter(f => f.type === 'state').at(-1)

beforeEach(() => {
  // `MOBILE` is read at import time from the build flag, which is what the native shell has.
  vi.stubEnv('VITE_MOBILE', '1')
  vi.resetModules()
  localStorage.clear()
  bridge.sent.length = 0
  bridge.listeners = {}
})

afterEach(() => {
  vi.unstubAllEnvs()
})

/**
 * The first test in this file pays for every module it imports, because vitest transforms them on
 * first use and charges that time to the test that triggers it: a `vi.resetModules()` plus a boot of
 * the whole store costs ~1-3 s on this machine and more when 400 other files are transforming in
 * parallel. Observed as a `Test timed out in 5000ms` (not an assertion failure) in 2 of 5 full-suite
 * runs, and never in isolation. The budget is raised rather than the work reduced: the alternative is
 * a green suite that fails at random, which is worse than a slightly slower one.
 */
const SLOW_BOOT = { timeout: 30_000 }

describe('a phone-side restart under a live link', () => {
  it('keeps the watch receiving: the epoch continues instead of rewinding to 1', SLOW_BOOT, async () => {
    const watch = watchReceiveGate()

    const first = await boot()
    first.useStore.setState({ S: { ...doc(), active: { ...doc().active, cur: 1 } } })
    first.link.publishWearState()
    first.useStore.setState({ S: { ...doc(), active: { ...doc().active, cur: 0 } } })
    first.link.publishWearState()
    let sent = drain(watch)
    const mark = watch.highWaterRev
    expect(mark).toBeGreaterThan(1)
    expect(watch.snapshot.workout.exerciseIndex).toBe(0)

    // The page load: a new JS context, the link (and therefore the watch's mark) untouched.
    vi.resetModules()
    const second = await boot({ cur: 1 })
    expect(second.link.wearLinkStatus().rev).toBeGreaterThan(mark)

    sent = drain(watch, sent)
    expect(watch.highWaterRev).toBe(second.link.wearLinkStatus().rev)
    expect(watch.snapshot.workout.exerciseIndex).toBe(1)
  })

  it('keeps the skip working: Skip pressed after the restart leaves the watch’s rest screen', SLOW_BOOT, async () => {
    const watch = watchReceiveGate()

    // A rest is running and the watch is showing it.
    const first = await boot()
    first.useStore.setState({ S: { ...doc(), active: { ...doc().active, cur: 1 } } })
    first.link.publishWearState()
    first.useUI.setState({ timer: runningRest() })
    first.link.publishWearState()
    let sent = drain(watch)
    expect(watch.isResting).toBe(true)
    const mark = watch.highWaterRev

    // The phone's WebView reloads mid-rest. `gym_rest` outlives it (store/useUI.js), so the rest
    // comes back — which is exactly how the watch keeps counting down after the phone restarted.
    vi.resetModules()
    const second = await boot()
    second.useStore.setState({ S: { ...doc(), active: { ...doc().active, cur: 1 } }, user: null, ready: false })
    second.useUI.setState({ timer: runningRest() })
    second.link.publishWearState()
    sent = drain(watch, sent)
    expect(second.link.wearLinkStatus().rev).toBeGreaterThan(mark)

    // Skip, through the same path the watch's command takes: the store action with `useUI`'s own
    // rest actions, then the publish that follows the ack (lib/wear-link.js `onCommand`).
    const ui = second.useUI.getState()
    const result = second.useStore.getState().applyWatchCommand(
      { v: 1, type: 'command', id: 'c-1-1', name: 'skipRest', baseRev: second.link.wearLinkStatus().rev, issuedAt: 1, args: {} },
      { startRest: ui.startRest, addRest: ui.addRest, stopRest: ui.stopRest, timer: ui.timer },
    )
    expect(result.applied).toBe(true)
    second.link.publishWearState()
    sent = drain(watch, sent)

    expect(watch.snapshot.rest.running).toBe(false)
    expect(watch.isResting).toBe(false)
  })
})

describe('the epoch announcement', () => {
  it('is due when this context has no predecessor’s rev, and is sent before the first state', SLOW_BOOT, async () => {
    const ctx = await boot()
    const frames = bridge.sent.map(f => JSON.parse(f))

    expect(ctx.link.wearLinkStatus().revEpoch).toBe('continued') // it was announced, so it is no longer pending
    expect(frames.filter(f => f.type === 'hello' && f.role === 'phone')).toHaveLength(1)
    const hello = frames.findIndex(f => f.type === 'hello' && f.role === 'phone')
    const state = frames.findIndex(f => f.type === 'state')
    expect(hello).toBeGreaterThanOrEqual(0)
    expect(hello).toBeLessThan(state)
    expect(localStorage.getItem(ctx.link.REV_KEY)).toBe('1')
  })

  it('is not sent while the epoch continues: a reset with nothing restarted would drop a mark still in use', SLOW_BOOT, async () => {
    const first = await boot()
    const mark = first.link.wearLinkStatus().rev

    vi.resetModules()
    const second = await boot()
    const frames = bridge.sent.map(f => JSON.parse(f))

    expect(second.link.wearLinkStatus().rev).toBeGreaterThan(mark)
    expect(frames.filter(f => f.type === 'hello' && f.role === 'phone')).toHaveLength(1) // the first boot's only
  })
})

// M7.1 / M7.3, plan §2.2-§2.3, the load-bearing half of the contract:
//
//   "`applied` must always be followed by a fresh `state` with a higher `rev` — including when
//    `cur` already equals `index`."
//
// The watch's tap stays *pending* until it sees `state.exerciseIndex == index` (§2.4), so an
// `applied` that published nothing would leave the tapped row pending for ever. A content-changing
// command bumps `rev` on its own; the identical case is what `publish({ bumpRev: true })` exists for.
// These tests drive the real `onCommand` through the plugin's `frame` listener, with the real store.
describe('applied commands always publish a fresh state with a higher rev (plan §2.2-§2.3)', () => {
  const ackFor = id => framesSent().filter(f => f.type === 'ack' && f.id === id)
  const statesSince = from => framesSent().slice(from).filter(f => f.type === 'state')

  it('selectExercise onto the index that is already current is applied, not duplicate, and bumps rev', async () => {
    const ctx = await boot({ cur: 1 })
    const before = ctx.link.wearLinkStatus().rev
    const mark = bridge.sent.length

    await deliver(command('selectExercise', 'c-1-1', { index: 1 }, before))

    expect(ctx.link.wearLinkStatus().rev).toBeGreaterThan(before)
    expect(ackFor('c-1-1')).toEqual([
      expect.objectContaining({ result: 'applied', reason: null, id: 'c-1-1' }),
    ])
    const states = statesSince(mark)
    expect(states.length).toBeGreaterThanOrEqual(1)
    expect(states.at(-1).rev).toBe(ctx.link.wearLinkStatus().rev)
    expect(states.at(-1).workout.exerciseIndex).toBe(1)
  })

  it('selectExercise onto the current index still clears the watch’s pending row', async () => {
    const watch = watchReceiveGate()
    const ctx = await boot({ cur: 0 })
    let sent = drain(watch)
    const before = watch.highWaterRev

    await deliver(command('selectExercise', 'c-1-2', { index: 0 }, ctx.link.wearLinkStatus().rev))

    sent = drain(watch, sent)
    expect(watch.dropped).toBe(0) // nothing the watch had to drop: the rev really did move
    expect(watch.highWaterRev).toBeGreaterThan(before)
    expect(watch.snapshot.workout.exerciseIndex).toBe(0)
  })

  it('selectExercise onto another index moves the marker and bumps rev', async () => {
    const ctx = await boot({ cur: 0 })
    const before = ctx.link.wearLinkStatus().rev
    const mark = bridge.sent.length

    await deliver(command('selectExercise', 'c-1-3', { index: 1 }, before))

    expect(ctx.link.wearLinkStatus().rev).toBeGreaterThan(before)
    expect(statesSince(mark).at(-1).workout.exerciseIndex).toBe(1)
    expect(ackFor('c-1-3')[0].result).toBe('applied')
  })

  it('setWeight with the value already stored is applied and bumps rev', async () => {
    const ctx = await boot({ cur: 0 })
    const before = ctx.link.wearLinkStatus().rev
    const stored = ctx.useStore.getState().S.active.entries[0].sets[1].w
    const mark = bridge.sent.length

    await deliver(command('setWeight', 'c-1-4', { kg: stored }, before))

    expect(ackFor('c-1-4')[0].result).toBe('applied')
    expect(ctx.link.wearLinkStatus().rev).toBeGreaterThan(before)
    expect(statesSince(mark).at(-1).rev).toBe(ctx.link.wearLinkStatus().rev)
  })

  it('setReps with the value already stored is applied and bumps rev', async () => {
    const ctx = await boot({ cur: 0 })
    const before = ctx.link.wearLinkStatus().rev
    const stored = ctx.useStore.getState().S.active.entries[0].sets[1].r
    const mark = bridge.sent.length

    await deliver(command('setReps', 'c-1-5', { reps: stored }, before))

    expect(ackFor('c-1-5')[0].result).toBe('applied')
    expect(ctx.link.wearLinkStatus().rev).toBeGreaterThan(before)
    expect(statesSince(mark).at(-1).rev).toBe(ctx.link.wearLinkStatus().rev)
  })

  it('a rejected selectExercise answers rejected and does not bump rev', async () => {
    const ctx = await boot({ cur: 0 })
    const before = ctx.link.wearLinkStatus().rev
    const mark = bridge.sent.length

    await deliver(command('selectExercise', 'c-1-6', { index: 9 }, before))

    expect(ackFor('c-1-6')).toEqual([
      expect.objectContaining({ result: 'rejected', reason: 'invalid' }),
    ])
    expect(ctx.link.wearLinkStatus().rev).toBe(before)
    expect(statesSince(mark)).toHaveLength(0)
  })

  it('a replayed id is answered duplicate and does not bump rev — duplicate is for replays only', async () => {
    const ctx = await boot({ cur: 0 })
    await deliver(command('selectExercise', 'c-1-7', { index: 1 }, ctx.link.wearLinkStatus().rev))
    const afterFirst = ctx.link.wearLinkStatus().rev
    const mark = bridge.sent.length

    await deliver(command('selectExercise', 'c-1-7', { index: 1 }, afterFirst))

    expect(ackFor('c-1-7')).toEqual([
      expect.objectContaining({ result: 'applied' }),
      expect.objectContaining({ result: 'duplicate' }),
    ])
    expect(ctx.link.wearLinkStatus().rev).toBe(afterFirst)
    expect(statesSince(mark)).toHaveLength(0)
  })
})
