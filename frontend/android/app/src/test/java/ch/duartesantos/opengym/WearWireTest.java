package ch.duartesantos.opengym;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The native frame codec. The vectors are the ones {@code src/lib/wear-frames.test.js} uses — the
 * bytes the watch really put on the wire, captured in `docs/notes/08-protocol-transport.md` — so the
 * Java half is checked against the wire, not against itself.
 */
public class WearWireTest {

    /** The exact hello the watch sent to the host listener on emulator-5554. */
    private static final String WATCH_HELLO_AS_RECEIVED =
            "{\"v\":1,\"type\":\"hello\",\"role\":\"watch\",\"proto\":[1],\"sentAt\":1791676082855}";

    @Test
    public void decodesTheHelloTheWatchActuallySent() {
        WearWire.Frame frame = WearWire.parse(WATCH_HELLO_AS_RECEIVED);
        assertNotNull(frame);
        assertEquals(WearWire.TYPE_HELLO, frame.type);
        assertEquals(WearWire.ROLE_WATCH, frame.role);
        assertEquals(1, frame.proto.length);
        assertEquals(1, frame.proto[0]);
        assertEquals(1791676082855L, frame.sentAt);
    }

    @Test
    public void decodesTheCommandTheWatchSends() {
        WearWire.Frame frame = WearWire.parse(
                "{\"v\":1,\"type\":\"command\",\"id\":\"c-1-4\",\"name\":\"adjustWeight\",\"baseRev\":17,\"issuedAt\":5,\"args\":{\"deltaKg\":0.5}}");
        assertNotNull(frame);
        assertTrue(frame.isCommand());
        assertEquals("c-1-4", frame.id);
        assertEquals("adjustWeight", frame.name);
    }

    @Test
    public void aNestedArgumentObjectCannotBeMistakenForTheFramesOwnFields() {
        // The scanner must skip nested values by balance: the args object here repeats both field
        // names the decision depends on, and neither may win.
        WearWire.Frame frame = WearWire.parse(
                "{\"v\":1,\"type\":\"command\",\"id\":\"c-1-1\",\"name\":\"adjustWeight\",\"args\":{\"id\":\"nested\",\"name\":\"nested\",\"type\":\"command\"}}");
        assertNotNull(frame);
        assertEquals("c-1-1", frame.id);
        assertEquals("adjustWeight", frame.name);
        assertEquals(WearWire.TYPE_COMMAND, frame.type);
    }

    @Test
    public void decodesTheStateFrameItHasToCache() {
        WearWire.Frame frame = WearWire.parse(
                "{\"v\":1,\"type\":\"state\",\"rev\":17,\"sentAt\":1791665144842,\"workout\":null,\"rest\":{\"running\":false,\"total\":90}}");
        assertNotNull(frame);
        assertEquals(WearWire.TYPE_STATE, frame.type);
        assertEquals(17L, frame.rev);
        assertEquals(1791665144842L, frame.sentAt);
    }

    @Test
    public void decodesAckAndPingAndPong() {
        WearWire.Frame ack = WearWire.parse("{\"v\":1,\"type\":\"ack\",\"id\":\"c-1-4\",\"result\":\"applied\",\"reason\":null,\"rev\":18,\"sentAt\":6}");
        assertNotNull(ack);
        assertEquals(WearWire.ACK_APPLIED, ack.result);
        assertNull(ack.reason);
        assertEquals(18L, ack.rev);

        WearWire.Frame ping = WearWire.parse("{\"v\":1,\"type\":\"ping\",\"t\":7}");
        assertNotNull(ping);
        assertEquals(7L, ping.t);

        // A null `t` is 0, exactly as the JS decoder reads it.
        WearWire.Frame nullT = WearWire.parse("{\"v\":1,\"type\":\"ping\",\"t\":null}");
        assertNotNull(nullT);
        assertEquals(0L, nullT.t);
    }

    @Test
    public void decodingIsTotalABadFrameIsDroppedAndNothingThrows() {
        String[] bad = {
            null,
            "",
            "   ",
            "not json at all",
            "[1,2,3]",
            "\"a string\"",
            "null",
            "{",
            "{\"v\":1",
            "{\"v\":1,",
            "{\"v\":1,\"type\":\"hello\"",
            "{\"v\":2,\"type\":\"hello\",\"role\":\"watch\",\"proto\":[1]}",
            "{\"type\":\"hello\",\"role\":\"watch\",\"proto\":[1]}",
            "{\"v\":\"1\",\"type\":\"hello\",\"role\":\"watch\",\"proto\":[1]}",
            "{\"v\":1,\"type\":\"hello\",\"role\":\"fridge\",\"proto\":[1]}",
            "{\"v\":1,\"type\":\"hello\",\"role\":\"watch\",\"proto\":\"one\"}",
            "{\"v\":1,\"type\":\"hello\",\"role\":\"watch\"}",
            "{\"v\":1,\"type\":\"command\",\"id\":\"c-1-1\"}",
            "{\"v\":1,\"type\":\"command\",\"name\":\"completeSet\"}",
            "{\"v\":1,\"type\":\"ack\",\"id\":\"c-1-1\"}",
            "{\"v\":1,\"type\":\"state\",\"rev\":\"17\"}",
            "{\"v\":1,\"type\":\"state\"}",
            "{\"v\":1,\"type\":\"whatever\"}",
        };
        for (String text : bad) {
            assertNull("should not decode: " + text, WearWire.parse(text));
        }
    }

    @Test
    public void decodesAProtoListOfSeveralVersions() {
        WearWire.Frame frame = WearWire.parse("{\"v\":1,\"type\":\"hello\",\"role\":\"watch\",\"proto\":[1,2],\"sentAt\":0}");
        assertNotNull(frame);
        assertEquals(2, frame.proto.length);
        assertEquals(2, frame.proto[1]);
    }

    @Test
    public void whatItEncodesItCanReadBack() {
        WearWire.Frame hello = WearWire.parse(WearWire.encodeHello(WearWire.ROLE_PHONE, 1791676082860L, new int[] {1}));
        assertNotNull(hello);
        assertEquals(WearWire.ROLE_PHONE, hello.role);
        assertEquals(1, hello.proto[0]);

        WearWire.Frame ack = WearWire.parse(WearWire.encodeAck("c-1-4", WearWire.ACK_REJECTED, WearWire.REASON_INVALID, 18, 6));
        assertNotNull(ack);
        assertEquals("c-1-4", ack.id);
        assertEquals(WearWire.ACK_REJECTED, ack.result);
        assertEquals(WearWire.REASON_INVALID, ack.reason);

        WearWire.Frame pong = WearWire.parse(WearWire.encodePong(7));
        assertNotNull(pong);
        assertEquals(WearWire.TYPE_PONG, pong.type);
        assertEquals(7L, pong.t);
    }

    @Test
    public void anIdWithQuotesOrEscapesSurvivesTheEncoder() {
        String id = "c-\"1\"-\\4-\n";
        WearWire.Frame ack = WearWire.parse(WearWire.encodeAck(id, WearWire.ACK_REJECTED, WearWire.REASON_INVALID, 1, 2));
        assertNotNull(ack);
        assertEquals(id, ack.id);
    }

    @Test
    public void oversizedInputIsNotParsed() {
        StringBuilder big = new StringBuilder("{\"v\":1,\"type\":\"command\",\"id\":\"c\",\"name\":\"x\",\"pad\":\"");
        while (big.length() < WearWire.MAX_FRAME_CHARS + 10) big.append('a');
        big.append("\"}");
        assertNull(WearWire.parse(big.toString()));
    }
}
