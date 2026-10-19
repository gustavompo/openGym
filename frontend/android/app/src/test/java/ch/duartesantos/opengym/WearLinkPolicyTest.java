package ch.duartesantos.opengym;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;

import org.junit.Test;

/**
 * The native-side decision, and the refusal it sends when it cannot act.
 *
 * <p>The load-bearing case is the pair at the top: a {@code hello} is answered with no JS at all,
 * a {@code command} is refused with no JS at all. Answering a command natively is not an option
 * (the store actions that keep the watch and the phone UI identical live in JS), and applying it
 * optimistically is worse than refusing it. The refusal has to be {@code busy}, which is the one
 * reason the watch retries.
 */
public class WearLinkPolicyTest {

    private static final String HELLO = "{\"v\":1,\"type\":\"hello\",\"role\":\"watch\",\"proto\":[1],\"sentAt\":1791676082855}";
    private static final String COMMAND =
            "{\"v\":1,\"type\":\"command\",\"id\":\"c-1791665134901-4\",\"name\":\"completeSet\",\"baseRev\":17,\"issuedAt\":5,\"args\":{}}";
    private static final String PING = "{\"v\":1,\"type\":\"ping\",\"t\":7}";

    @Test
    public void aHelloIsServedFromNativeCodeWhetherOrNotJsIsAlive() {
        for (boolean js : new boolean[] {false, true}) {
            assertEquals(
                    "JS attached=" + js,
                    WearLinkPolicy.Action.SERVE_HELLO_AND_STATE,
                    WearLinkPolicy.decide(WearWire.parse(HELLO), js));
        }
    }

    @Test
    public void aCommandWithNoJsIsRefusedNotFaked() {
        assertEquals(WearLinkPolicy.Action.REJECT_COMMAND, WearLinkPolicy.decide(WearWire.parse(COMMAND), false));
    }

    @Test
    public void aCommandWithJsIsHandedToJs() {
        assertEquals(WearLinkPolicy.Action.HAND_TO_JS, WearLinkPolicy.decide(WearWire.parse(COMMAND), true));
    }

    @Test
    public void aPingIsAnsweredNativelyTooSoAProbeWorksWhileFrozen() {
        assertEquals(WearLinkPolicy.Action.PONG, WearLinkPolicy.decide(WearWire.parse(PING), false));
        assertEquals(WearLinkPolicy.Action.PONG, WearLinkPolicy.decide(WearWire.parse(PING), true));
    }

    @Test
    public void anythingElseIsIgnoredIncludingOurOwnFramesComingBack() {
        String[] ignored = {
            "{\"v\":1,\"type\":\"ack\",\"id\":\"c-1-1\",\"result\":\"applied\",\"rev\":18,\"sentAt\":6}",
            "{\"v\":1,\"type\":\"pong\",\"t\":7}",
            "{\"v\":1,\"type\":\"state\",\"rev\":17,\"sentAt\":5,\"workout\":null,\"rest\":{\"running\":false,\"total\":90}}",
            "{\"v\":1,\"type\":\"whatever\"}",
            "not json",
        };
        for (String text : ignored) {
            assertEquals("ignored: " + text, WearLinkPolicy.Action.IGNORE, WearLinkPolicy.decide(WearWire.parse(text), true));
        }
        assertEquals(WearLinkPolicy.Action.IGNORE, WearLinkPolicy.decide(null, true));
    }

    @Test
    public void theRefusalIsTheProtocolsOwnRejectedOutcomeUnderTheSameId() {
        WearWire.Frame command = WearWire.parse(COMMAND);
        WearWire.Frame ack = WearWire.parse(WearLinkPolicy.jsUnavailableAck(command, 17, 1791665134950L));
        assertNotNull(ack);
        assertEquals(WearWire.TYPE_ACK, ack.type);
        assertEquals("the id the watch issued it under, so its retry is idempotent", "c-1791665134901-4", ack.id);
        assertEquals(WearWire.ACK_REJECTED, ack.result);
        // `busy`, not `invalid` — see theRetryableReasonIsTheOnlyHonestOne. This assertion originally
        // said REASON_INVALID, which encoded a design that contradicts the fixed contract.
        assertEquals(WearWire.REASON_BUSY, ack.reason);
        assertEquals(17L, ack.rev);
        assertEquals(1791665134950L, ack.sentAt);
    }

    /**
     * The refusal has to be one the watch actually retries. `docs/protocol.md` §3.2 and §5.5: only
     * `busy` (and an unrecognised reason) is retryable; `stale`, `noWorkout` and `invalid` are
     * terminal on the watch (`TERMINAL_REFUSAL_REASONS` in the watch's `TransportWorkoutRepository`),
     * and `12-datalayer-decisions.md` §4 requires the refusal to be the kind the watch retries under
     * the same id. Sending `invalid` there would drop the user's tap for good.
     */
    @Test
    public void theRetryableReasonIsTheOnlyHonestOne() {
        String[] terminalOnTheWatch = {WearWire.REASON_STALE, WearWire.REASON_NO_WORKOUT, WearWire.REASON_INVALID};
        WearWire.Frame ack = WearWire.parse(WearLinkPolicy.jsUnavailableAck(WearWire.parse(COMMAND), 17, 1));
        assertNotNull(ack);
        assertEquals(WearWire.REASON_BUSY, ack.reason);
        for (String terminal : terminalOnTheWatch) {
            assertNotEquals("a " + terminal + " refusal would end the watch's retries", terminal, ack.reason);
        }
    }

    @Test
    public void theRefusalIsDeterministicSoBothTheImmediateAndTheTimedOutPathSendsOneShape() {
        WearWire.Frame command = WearWire.parse(COMMAND);
        assertEquals(
                WearLinkPolicy.jsUnavailableAck(command, 17, 1000),
                WearLinkPolicy.jsUnavailableAck(WearWire.parse(COMMAND), 17, 1000));
    }

    @Test
    public void anEmptyCacheStillProducesARevTheWatchCanUse() {
        WearWire.Frame ack = WearWire.parse(WearLinkPolicy.jsUnavailableAck(WearWire.parse(COMMAND), -1, 5));
        assertNotNull(ack);
        assertEquals(0L, ack.rev);
    }
}
