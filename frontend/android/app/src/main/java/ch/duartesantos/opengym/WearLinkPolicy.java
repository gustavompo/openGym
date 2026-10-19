package ch.duartesantos.opengym;

/**
 * What native code does with one frame that arrived while it — not JS — was the thing AMS woke up
 * for. This is the load-bearing split of decision 3/4 in
 * {@code docs/notes/12-datalayer-decisions.md}:
 *
 * <ul>
 *   <li><b>State is answered natively.</b> {@code hello} → our {@code hello} plus the cached
 *       {@code state} frame; {@code ping} → {@code pong}. A frozen WebView cannot stop these.
 *   <li><b>Commands are not.</b> The seven commands must go through openGym's own store actions,
 *       which live in JS — that is exactly why the watch and the phone UI cannot diverge. So a
 *       command is handed to JS, and when there is no JS it is <b>refused</b>, never applied and
 *       never faked: the protocol's existing {@code rejected} outcome, under the same id, so a
 *       retry stays idempotent.
 * </ul>
 *
 * <p>Separated from {@link WearLink} (which needs Android's Handler and Context) so the decision
 * itself is unit-tested on a plain JVM: {@code WearLinkPolicyTest}.
 */
public final class WearLinkPolicy {

    public enum Action {
        /** Answer {@code hello} ourselves, then the cached {@code state} frame if there is one. */
        SERVE_HELLO_AND_STATE,
        /** Answer {@code pong}. Keeps a liveness probe working with no WebView at all. */
        PONG,
        /** A command: hand it to JS, and expect an {@code ack} back within the timeout. */
        HAND_TO_JS,
        /** A command with no JS to apply it: answer {@code rejected/busy} for the same id. */
        REJECT_COMMAND,
        /** Malformed, unknown, our own frame type coming back, or {@code v} we do not speak. */
        IGNORE,
    }

    private WearLinkPolicy() {}

    /**
     * @param frame      the decoded inbound frame, or null when it did not decode
     * @param jsAttached whether a live WebView has registered itself with the bridge
     */
    public static Action decide(WearWire.Frame frame, boolean jsAttached) {
        if (frame == null) return Action.IGNORE;
        if (WearWire.TYPE_HELLO.equals(frame.type)) {
            // Answered whether or not JS is attached: this is the one frame that must work while the
            // process is frozen, and it is the whole reason the cache exists.
            return Action.SERVE_HELLO_AND_STATE;
        }
        if (WearWire.TYPE_COMMAND.equals(frame.type)) {
            return jsAttached ? Action.HAND_TO_JS : Action.REJECT_COMMAND;
        }
        if (WearWire.TYPE_PING.equals(frame.type)) return Action.PONG;
        return Action.IGNORE;
    }

    /**
     * The refusal native code sends when a command cannot be applied, because there is no live JS
     * (immediately), or because the JS it was handed to did not answer in time.
     *
     * <p>{@code busy} — the protocol's own reason for "the phone understood it but cannot apply it
     * right now — canonically, the WebView/JS is frozen and no workout-scoped foreground service is
     * alive" (`docs/protocol.md` §3.2, `12-datalayer-decisions.md` §4). It is the <b>only</b> one of
     * the four reasons this case may use: {@code stale}, {@code noWorkout} and {@code invalid} are
     * all terminal on the watch (`TERMINAL_REFUSAL_REASONS` in the watch's
     * `TransportWorkoutRepository.kt`), so any of them would drop the user's tap for good, which is
     * the exact opposite of decision §4 ("so the watch retries under the same id").
     *
     * <p>The {@code rev} is the cached one, so the watch's high-water mark is unaffected by a
     * refusal.
     */
    public static String jsUnavailableAck(WearWire.Frame command, long cachedRev, long now) {
        return WearWire.encodeAck(command.id, WearWire.ACK_REJECTED, WearWire.REASON_BUSY, Math.max(cachedRev, 0), now);
    }
}
