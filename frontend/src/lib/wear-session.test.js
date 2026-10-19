import { beforeEach, describe, expect, it } from 'vitest'
import { _resetWearSession, setWearSessionDriver, syncWearSession, wearSessionStatus } from './wear-session.js'

// The service under test is native; what is testable here is the edge logic that decides *when* the
// page asks for it. A start that is never sent is the defect that made M4.7 dead code, and a start
// sent on every publish would be a bridge call per document write for the whole workout.
const WORKOUT = { id: 'mv2vufc29liyv', name: 'Full Body A' }

let calls
const okDriver = () => call => {
  calls.push(call)
  return Promise.resolve({ started: true, running: false })
}

beforeEach(() => {
  _resetWearSession()
  calls = []
})

describe('the workout-scoped foreground service (M4.7)', () => {
  it('is not asked for at all until the link has installed a driver', async () => {
    await expect(syncWearSession(WORKOUT)).resolves.toBeNull()
    expect(wearSessionStatus().calls).toBe(0)
    expect(wearSessionStatus().error).toBe('no driver')
  })

  it('starts on the workout appearing, with the workout name as the notification title', async () => {
    setWearSessionDriver(okDriver())
    await syncWearSession(WORKOUT)
    expect(calls).toEqual([{ active: true, title: 'Full Body A' }])
  })

  it('sends nothing while the same workout stays open', async () => {
    setWearSessionDriver(okDriver())
    await syncWearSession(WORKOUT)
    await syncWearSession(WORKOUT)
    await syncWearSession(WORKOUT)
    expect(calls).toHaveLength(1)
  })

  it('stops on the workout ending, and starts again on the next one', async () => {
    setWearSessionDriver(okDriver())
    await syncWearSession(WORKOUT)
    await syncWearSession(null)
    await syncWearSession(WORKOUT)
    expect(calls).toEqual([
      { active: true, title: 'Full Body A' },
      { active: false, title: null },
      { active: true, title: 'Full Body A' },
    ])
  })

  it('crosses the edge once when two publishes land in the same turn', async () => {
    setWearSessionDriver(okDriver())
    await Promise.all([syncWearSession(WORKOUT), syncWearSession(WORKOUT)])
    expect(calls).toHaveLength(1)
  })

  // Android 12+ refuses a background foreground-service start. That is the honest outcome, not a
  // reason to believe the workout is protected: the edge stays open so the next publish retries.
  it('retries after a refused start instead of counting the workout as covered', async () => {
    const replies = [{ started: false, running: false }, { started: true, running: false }]
    setWearSessionDriver(call => {
      calls.push(call)
      return Promise.resolve(replies.shift())
    })
    await syncWearSession(WORKOUT)
    expect(wearSessionStatus().sent).toBeNull()
    await syncWearSession(WORKOUT)
    expect(calls).toHaveLength(2)
    expect(wearSessionStatus().sent).toBe(true)
  })

  it('survives a driver that rejects, records it, and never rejects itself', async () => {
    setWearSessionDriver(() => Promise.reject(new Error('no context')))
    await expect(syncWearSession(WORKOUT)).resolves.toEqual({ started: false })
    expect(wearSessionStatus().error).toBe('no context')
    expect(wearSessionStatus().sent).toBeNull()
  })

  // The plugin reads `WearSessionService.isRunning()` before `onStartCommand` can have run, so it is
  // false on every successful start. Treating it as the success signal would re-send the start on
  // every publish for the whole workout.
  it('does not treat the plugin running:false right after a start as a failure', async () => {
    setWearSessionDriver(okDriver())
    await syncWearSession(WORKOUT)
    await syncWearSession(WORKOUT)
    expect(wearSessionStatus().sent).toBe(true)
    expect(wearSessionStatus().result).toEqual({ started: true, running: false })
    expect(calls).toHaveLength(1)
  })
})
