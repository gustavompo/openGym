// The workout-scoped foreground service (M4.7), driven from the projection. Native half:
// `android/app/src/main/java/ch/duartesantos/opengym/WearSessionService.java`, started through the
// `WearBridge.session()` plugin method.
//
// Why it exists at all, measured: ~50 s after openGym stops being visible Android's
// `CachedAppOptimizer` freezes the whole process (`isFrozen=true`, cgroup `2:cpu:/background`), and
// a frozen WebView runs no JS. Every one of the seven commands has to go through openGym's own
// store actions, which live in JS, so with the process frozen every watch tap is refused `busy`
// (retryable — nothing is silently lost, nothing is applied either) until the user brings the phone
// forward. A foreground service for the length of the workout is what keeps the process out of the
// cached-app freezer, and that is a correctness requirement rather than a nicety
// (docs/notes/12-datalayer-decisions.md §4).
//
// Scope is the workout, nothing wider: a workout becoming active starts it, the workout ending stops
// it, and the notification goes with it. The rest countdown owns its own service and its own
// notification (`RestTimerService`, id 41); this one is 42→43 (see `NOTIFICATION_ID` below).
//
// Like `wear-sink.js`, this file imports nothing. That is what lets `wear-link.js` (which imports
// the store) be the only side that knows about the Capacitor bridge, and keeps the edge logic
// testable in vitest with no native shell in sight. Until a driver is installed — a link that never
// started, a web build, iOS, a unit test — every call here is a cheap no-op.
let driver = null
/** The projection's last word on "is a workout running". Null before the first sync. */
let desired = null
/** The last state actually handed to native code: the edge is only crossed when this differs. */
let sent = null
let lastResult = null
let lastError = null
let calls = 0

/** Installed by `lib/wear-link.js` when the link starts. Returns the previous driver (for tests). */
export function setWearSessionDriver(fn) {
  const previous = driver
  driver = typeof fn === 'function' ? fn : null
  return previous
}

/**
 * Called from the publish path with `projection.workout` (null when no session is running). Starts
 * the service once when a workout appears, stops it once when the workout ends — repeatedly calling
 * it with the same answer sends nothing.
 *
 * Never throws and never rejects: a refused start is the honest outcome recorded in the status
 * below, not an error the publish path has to handle. `started:false` (Android 12+ refuses a
 * background foreground-service start, which is why the page only ever starts a workout on screen)
 * leaves the edge open, so the next publish tries again rather than leaving the workout unfrozen.
 */
export function syncWearSession(workout) {
  const active = !!workout
  desired = active
  if (!driver) {
    lastError = 'no driver'
    return Promise.resolve(null)
  }
  if (sent === active) return Promise.resolve(lastResult)
  // Set before the native call: two publishes in the same turn (a persist and the rest timer, say)
  // must not both cross the same edge.
  sent = active
  calls += 1
  const call = { active, title: active ? String(workout.name || '') : null }
  return driver(call).then(
    result => {
      lastResult = result || null
      lastError = null
      // `running` is read before the service's `onStartCommand` can run, so it is always false right
      // after a start and is not a success signal. `started` (the call was refused) is.
      if (active && (!result || result.started === false)) sent = null
      return lastResult
    },
    error => {
      lastError = String(error?.message || error)
      lastResult = { started: false }
      sent = null
      return lastResult
    }
  )
}

/** Read-only view, for the on-device evidence and the debug console. */
export function wearSessionStatus() {
  return { desired, sent, calls, result: lastResult, error: lastError, hasDriver: !!driver }
}

/** Tests only: forget the driver and the last edge, as a fresh process would. */
export function _resetWearSession() {
  driver = null
  desired = null
  sent = null
  lastResult = null
  lastError = null
  calls = 0
}
