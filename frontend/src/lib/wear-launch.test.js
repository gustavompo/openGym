import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LAUNCH_POLICY,
  _resetWearLaunch,
  launchKeys,
  launchTriggerFor,
  maybeLaunchWatch,
  setWearLaunchDriver,
  wearLaunchStatus,
} from './wear-launch.js'

// The projection shape `wear-projection.js` produces (only the fields the trigger reads matter).
const proj = ({ workout = null, rest = null } = {}) => ({
  workout,
  rest: { running: false, endsAt: null, ...rest },
})
const workout = startedAt => ({ id: 'w1', startedAt })

describe('wear-launch trigger policy', () => {
  beforeEach(() => {
    _resetWearLaunch()
  })

  it('is off by default for the every-frame alternative', () => {
    expect(LAUNCH_POLICY.onEveryFrame).toBe(false)
  })

  it('launches on a workout becoming active, and not again for the same workout', () => {
    expect(launchTriggerFor(proj({ workout: workout(1000) }), { workoutKey: null, restKey: null })).toBe(
      'workout-start'
    )
    expect(launchTriggerFor(proj({ workout: workout(1000) }), { workoutKey: '1000', restKey: null })).toBe(null)
  })

  it('does NOT launch on a rest start, which is the whole point of the workout-start trigger', () => {
    // Same workout (already launched at its start), a rest begins — no second launch.
    const resting = proj({ workout: workout(1000), rest: { running: true, endsAt: 5000 } })
    expect(launchTriggerFor(resting, { workoutKey: '1000', restKey: null })).toBe(null)
    // A second, genuinely new rest is still not a trigger.
    const next = proj({ workout: workout(1000), rest: { running: true, endsAt: 9000 } })
    expect(launchTriggerFor(next, { workoutKey: '1000', restKey: '5000' })).toBe(null)
  })

  it('launches on a rest start only when the optional onRestStart flag is turned on', () => {
    const on = LAUNCH_POLICY.onRestStart
    LAUNCH_POLICY.onRestStart = true
    try {
      const resting = proj({ workout: workout(1000), rest: { running: true, endsAt: 5000 } })
      expect(launchTriggerFor(resting, { workoutKey: '1000', restKey: null })).toBe('rest-start')
      // A second publish of the SAME rest (identical deadline) is not a new trigger.
      expect(launchTriggerFor(resting, { workoutKey: '1000', restKey: '5000' })).toBe(null)
    } finally {
      LAUNCH_POLICY.onRestStart = on
    }
  })

  it('prefers workout-start when both edges land in one publish', () => {
    const on = LAUNCH_POLICY.onRestStart
    LAUNCH_POLICY.onRestStart = true
    try {
      const both = proj({ workout: workout(1000), rest: { running: true, endsAt: 5000 } })
      expect(launchTriggerFor(both, { workoutKey: null, restKey: null })).toBe('workout-start')
    } finally {
      LAUNCH_POLICY.onRestStart = on
    }
  })

  it('does not launch on an idle projection', () => {
    expect(launchTriggerFor(proj(), { workoutKey: null, restKey: null })).toBe(null)
    expect(launchTriggerFor(proj(), { workoutKey: '1000', restKey: '5000' })).toBe(null)
  })

  it('keys a workout by startedAt, falling back to its id', () => {
    expect(launchKeys(proj({ workout: workout(1000) })).workoutKey).toBe('1000')
    expect(launchKeys(proj({ workout: { id: 'abc' } })).workoutKey).toBe('abc')
    expect(launchKeys(proj()).workoutKey).toBe(null)
    expect(launchKeys(proj()).restKey).toBe(null)
  })
})

describe('wear-launch driver', () => {
  beforeEach(() => {
    _resetWearLaunch()
  })

  it('calls the driver once per trigger and reports the trigger name', async () => {
    const driver = vi.fn(() => Promise.resolve({ requested: true, attempted: 1, nodes: 1 }))
    setWearLaunchDriver(driver)
    for (const t of [0, 100, 200, 300]) await maybeLaunchWatch(proj({ workout: workout(1000) }), t)
    expect(driver).toHaveBeenCalledTimes(1)
    expect(driver).toHaveBeenCalledWith({ trigger: 'workout-start' })
    expect(wearLaunchStatus().result).toEqual({ requested: true, attempted: 1, nodes: 1 })
  })

  it('rate-limits two different triggers that land inside minIntervalMs', async () => {
    const driver = vi.fn(() => Promise.resolve({ requested: true }))
    setWearLaunchDriver(driver)
    await maybeLaunchWatch(proj({ workout: workout(1000) }), 0)
    // A SECOND workout (a genuinely different trigger) immediately after: inside the window, so
    // suppressed. This is what a burst of publishes must not be able to defeat.
    await maybeLaunchWatch(proj({ workout: workout(2000) }), LAUNCH_POLICY.minIntervalMs - 1)
    expect(driver).toHaveBeenCalledTimes(1)
    // Once the window has passed, the next new trigger goes through.
    await maybeLaunchWatch(proj({ workout: workout(3000) }), LAUNCH_POLICY.minIntervalMs + 1)
    expect(driver).toHaveBeenCalledTimes(2)
  })

  it('records the absence of a driver rather than throwing', async () => {
    await maybeLaunchWatch(proj({ workout: workout(1000) }), 0)
    expect(wearLaunchStatus().error).toBe('no driver')
    expect(wearLaunchStatus().hasDriver).toBe(false)
  })

  it('records a driver failure instead of rejecting the publish path', async () => {
    setWearLaunchDriver(() => Promise.reject(new Error('no play services')))
    await expect(maybeLaunchWatch(proj({ workout: workout(1000) }), 0)).resolves.toEqual({ requested: false })
    expect(wearLaunchStatus().error).toBe('no play services')
  })

  it('never throws from the publish path when the projection is malformed', () => {
    setWearLaunchDriver(() => Promise.resolve({ requested: true }))
    expect(() => maybeLaunchWatch(undefined, 0)).not.toThrow()
    expect(() => maybeLaunchWatch({ rest: {} }, 0)).not.toThrow()
  })
})
