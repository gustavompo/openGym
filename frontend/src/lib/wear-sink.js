// The one hook from openGym's store to the watch link.
//
// `store/useStore.js` calls `publishWear(S)` from its `persist()` — the single function every write
// of the saved document goes through (an edit, a pull, an adoption, a restored backup, a finished
// workout). That is the "write choke point" the bridge needs: there is no second place a change
// could slip past.
//
// The indirection exists because the link module imports the store (for `S`) and the store would
// otherwise have to import the link (for the publish), which is a cycle. This file imports nothing,
// so both sides can depend on it. Before the bridge starts, the sink is null and the call is free.
let sink = null

/** Installed by `lib/wear-link.js` when it starts. Returns the previous sink (for tests). */
export function setWearSink(fn) {
  const previous = sink
  sink = typeof fn === 'function' ? fn : null
  return previous
}

/** Called from `persist()`. Never throws: a broken link must not break saving. */
export function publishWear(S) {
  if (!sink) return
  try {
    sink(S)
  } catch {
    /* the link is best-effort; the document is not */
  }
}
