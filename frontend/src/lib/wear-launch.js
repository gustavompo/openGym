// The phone half of "the watch app opens itself" (M8). Native half:
// `WearLaunch.java` + `WearLink.launchWatch()`, reached through the `WearBridge.launch()` plugin
// method. Findings and raw measurements: `docs/notes/26-watch-autolaunch-findings.md`.
//
// Why this is a separate module from `wear-link.js`, exactly like `wear-session.js`: the *decision*
// of when to bring the watch up is product policy and must be readable and testable with no native
// shell in sight. The *mechanism* is `WearBridge.launch()`. `wear-link.js` calls
// `maybeLaunchWatch(projection)` from the same publish path that already feeds `syncWearSession`.
//
// ============================================================================================
// ONE PLACE TO CHANGE THE POLICY. It is NOT FINAL: Gus is choosing it, deliberately.
// ============================================================================================
//
// The problem: bringing the watch up on *every* state publish would be obnoxious and hostile to
// battery (the watch screen lights up dozens of times per set). The stated case is "I tap complete
// set on the phone and the timer appears on the watch", so the provisional trigger set below is
// **workout becomes active** and **rest starts**, deduped by identity and rate-limited.
//
// Honest costs of this default (do not delete this note): a rest start makes his wrist light up
// while he is mid-set on the phone, and each launch costs the watch a screen wake. Both are the
// product question, not a mechanism question — measured behaviour is in docs/notes/26.
export const LAUNCH_POLICY = {
  /** The trigger: a workout becoming active brings the watch up, exactly once per workout. */
  onWorkoutStart: true,
  /**
   * OFF as of the orchestrator's 2026-10-11 re-scope. A rest start is *not* a launch trigger: the
   * watch was already raised when the workout began, and it stays up while the workout runs, so a
   * completed set reaches it as a `state` frame. Turning this on makes the watch screen light up on
   * every rest (what "complete set" does) and is the alternative the product review is weighing —
   * it is one boolean, nothing else changes. Honest cost of ON: a screen wake per rest.
   */
  onRestStart: false,
  onEveryFrame: false, // deliberately absent from the implemented set; kept as the named alternative
  /** A burst of publishes must not relaunch repeatedly. Dedupe below already catches the repeat of
   *  the *same* rest; this is the floor between two genuinely different triggers. */
  minIntervalMs: 15000,
}

let driver = null
/** Identity of the last workout seen: its start time, or its id when the start time is absent. */
let lastWorkoutKey = null
/** Identity of the last running rest: its absolute deadline, which is new for each rest. */
let lastRestKey = null
let lastLaunchAt = null
let calls = 0
let lastResult = null
let lastError = null

/** Installed by `lib/wear-link.js` when the link starts. Returns the previous driver (for tests). */
export function setWearLaunchDriver(fn) {
  const previous = driver
  driver = typeof fn === 'function' ? fn : null
  return previous
}

/**
 * A stable identity for "this workout" and "this rest", or null when there is none.
 *
 * A rest's identity is its absolute deadline, not a counter: the projection carries `endsAt` and
 * nothing else that changes between two rest starts of equal length. Two publishes of the same rest
 * therefore share a key and do not relaunch; a new rest has a new deadline and does.
 */
export function launchKeys(projection) {
  const workout = projection?.workout ?? null
  const rest = projection?.rest ?? null
  return {
    workoutKey: workout ? String(workout.startedAt ?? workout.id ?? '') : null,
    restKey: rest?.running && rest.endsAt ? String(rest.endsAt) : null,
  }
}

/** The trigger this projection crosses, or null. Pure, so the policy is testable without a device. */
export function launchTriggerFor(projection, prev) {
  const { workoutKey, restKey } = launchKeys(projection)
  if (LAUNCH_POLICY.onEveryFrame) return 'every-frame'
  // Workout start wins over rest start when both edges land in the same publish (a workout that
  // begins already resting is still one launch, not two).
  if (LAUNCH_POLICY.onWorkoutStart && workoutKey && workoutKey !== prev.workoutKey) return 'workout-start'
  if (LAUNCH_POLICY.onRestStart && restKey && restKey !== prev.restKey) return 'rest-start'
  return null
}

/**
 * Called from the publish path with the current projection. Launches at most once per trigger, and
 * never twice inside `LAUNCH_POLICY.minIntervalMs`.
 *
 * Never throws and never rejects: a failed launch is recorded in the status below, not an error the
 * publish path has to handle — the watch app not opening must not break the phone's save.
 */
export function maybeLaunchWatch(projection, now = Date.now()) {
  const prev = { workoutKey: lastWorkoutKey, restKey: lastRestKey }
  const trigger = launchTriggerFor(projection, prev)
  const next = launchKeys(projection)
  const rateLimited = lastLaunchAt !== null && now - lastLaunchAt < LAUNCH_POLICY.minIntervalMs
  // A trigger with no driver is NOT consumed: the link may still be starting, and the same trigger
  // must be free to fire on the next publish. The rate-limit drop still consumes it, as it always has.
  if (trigger && !driver && !rateLimited) {
    lastError = 'no driver'
    return Promise.resolve(null)
  }
  lastWorkoutKey = next.workoutKey
  lastRestKey = next.restKey
  if (!trigger || rateLimited) return Promise.resolve(null)
  lastLaunchAt = now
  calls += 1
  // A driver that throws synchronously (a bridge without the method, in a test or an old shell)
  // must be as harmless as one that rejects: the publish path this is called from must not break.
  let called
  try {
    called = driver({ trigger })
  } catch (error) {
    lastError = String(error?.message || error)
    lastResult = { requested: false }
    return Promise.resolve(lastResult)
  }
  return Promise.resolve(called).then(
    result => {
      lastResult = result || null
      lastError = null
      return lastResult
    },
    error => {
      lastError = String(error?.message || error)
      lastResult = { requested: false }
      return lastResult
    }
  )
}

/** Read-only view, for the on-device evidence and the debug console. */
export function wearLaunchStatus() {
  return {
    policy: LAUNCH_POLICY,
    workoutKey: lastWorkoutKey,
    restKey: lastRestKey,
    lastLaunchAt,
    calls,
    result: lastResult,
    error: lastError,
    hasDriver: !!driver,
  }
}

/** Tests only: forget the driver and the edges, as a fresh process would. */
export function _resetWearLaunch() {
  driver = null
  lastWorkoutKey = null
  lastRestKey = null
  lastLaunchAt = null
  calls = 0
  lastResult = null
  lastError = null
}
