package ch.duartesantos.opengym;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The native half of the phone ↔ watch wire format, version 1. Contract: {@code docs/protocol.md}.
 *
 * <p>This is deliberately <em>not</em> a second protocol implementation. It is the small subset of
 * the frame vocabulary that native code must act on <b>while the WebView is frozen or not running
 * at all</b> (decision 3/4 in {@code docs/notes/12-datalayer-decisions.md}):
 *
 * <ul>
 *   <li>{@code hello} — answered with our own {@code hello} plus the cached {@code state} frame,
 *       from native code, with no JS involvement;
 *   <li>{@code ping} — answered with {@code pong};
 *   <li>{@code command} — <em>recognised</em> here only so it can be handed to JS, and refused with
 *       a protocol {@code rejected} ack when there is no JS to hand it to;
 *   <li>{@code state} — recognised so the plugin can cache the {@code rev} beside the frame text.
 * </ul>
 *
 * <p>Everything else stays in JS, where the projection, the store actions and the idempotency log
 * live: {@code frontend/src/lib/wear-frames.js} is still the full codec for the JavaScript half, and
 * the watch's {@code wear/link/WireProtocol.kt} for the Kotlin half. The three are kept in step by
 * {@code docs/protocol.md}, not by each other.
 *
 * <p>Decoding is total, like both other implementations: malformed JSON, a wrong-typed field, an
 * unknown {@code type} and an unsupported {@code v} all answer {@code null}, and a dropped frame
 * never breaks the link. No Android API is used here, so all of it runs under a plain JVM unit test
 * ({@code app/src/test/java/ch/duartesantos/opengym/WearWireTest.java}).
 */
public final class WearWire {

    /** The only major version that exists today. */
    public static final int PROTOCOL_VERSION = 1;

    /** The single message path both directions (decision 1). */
    public static final String PATH = "/opengym/wear";

    public static final String TYPE_HELLO = "hello";
    public static final String TYPE_STATE = "state";
    public static final String TYPE_COMMAND = "command";
    public static final String TYPE_ACK = "ack";
    public static final String TYPE_PING = "ping";
    public static final String TYPE_PONG = "pong";

    public static final String ROLE_PHONE = "phone";
    public static final String ROLE_WATCH = "watch";

    /** Protocol §3.2 outcomes. */
    public static final String ACK_APPLIED = "applied";

    public static final String ACK_DUPLICATE = "duplicate";
    public static final String ACK_REJECTED = "rejected";

    /**
     * §3.2 reasons. Native code only ever answers {@link #REASON_BUSY}: when there is no JS to
     * apply a command, the protocol's own name for "understood, but cannot apply it *right now*" is
     * the honest one — and, being retryable, it is the one that lets the watch retry the same id
     * when the phone can (decision §4, protocol §5.5).
     */
    public static final String REASON_STALE = "stale";

    public static final String REASON_NO_WORKOUT = "noWorkout";
    public static final String REASON_INVALID = "invalid";
    public static final String REASON_BUSY = "busy";

    /** A frame is a small JSON object; anything larger is a mistake (mirrors the TCP plugin's cap). */
    public static final int MAX_FRAME_CHARS = 64 * 1024;

    private WearWire() {}

    /** One decoded frame. Fields the frame's {@code type} does not carry stay at their defaults. */
    public static final class Frame {
        public final String type;
        public final String id;
        public final String name;
        public final String role;
        public final String result;
        public final String reason;
        public final int[] proto;
        /** {@code rev} of a {@code state} frame, or -1. */
        public final long rev;
        /** {@code sentAt} of a {@code state} frame, or -1. */
        public final long sentAt;
        /** {@code t} of a {@code ping}/{@code pong}, or -1. */
        public final long t;

        private Frame(String type, String id, String name, String role, String result, String reason,
                      int[] proto, long rev, long sentAt, long t) {
            this.type = type;
            this.id = id;
            this.name = name;
            this.role = role;
            this.result = result;
            this.reason = reason;
            this.proto = proto;
            this.rev = rev;
            this.sentAt = sentAt;
            this.t = t;
        }

        public boolean isCommand() {
            return TYPE_COMMAND.equals(type);
        }
    }

    // --- decoding -------------------------------------------------------------------------------

    /** Parses one frame. Returns null for anything native code cannot act on — see the class note. */
    public static Frame parse(String text) {
        if (text == null || text.length() > MAX_FRAME_CHARS) return null;
        Map<String, String> top;
        try {
            top = topLevel(text);
        } catch (RuntimeException e) {
            return null;
        }
        if (longOr(top.get("v"), -1) != PROTOCOL_VERSION) return null;
        String type = string(top.get("type"));
        if (type == null) return null;

        switch (type) {
            case TYPE_HELLO: {
                String role = string(top.get("role"));
                // Same two roles the JS decoder accepts (src/lib/wear-frames.js): a `hello` that
                // does not say who it is from is not a `hello` we can answer.
                if (!ROLE_WATCH.equals(role) && !ROLE_PHONE.equals(role)) return null;
                int[] proto = intArray(top.get("proto"));
                if (proto == null) return null;
                return new Frame(type, null, null, role, null, null, proto, -1, numberOr(top.get("sentAt"), -1), -1);
            }
            case TYPE_COMMAND: {
                String id = string(top.get("id"));
                String name = string(top.get("name"));
                if (id == null || name == null) return null;
                return new Frame(type, id, name, null, null, null, null, -1, -1, -1);
            }
            case TYPE_ACK: {
                String id = string(top.get("id"));
                String result = string(top.get("result"));
                if (id == null || result == null) return null;
                return new Frame(type, id, null, null, result, string(top.get("reason")), null,
                        numberOr(top.get("rev"), -1), numberOr(top.get("sentAt"), -1), -1);
            }
            case TYPE_STATE: {
                long rev = numberOr(top.get("rev"), -1);
                if (rev < 0) return null;
                return new Frame(type, null, null, null, null, null, null, rev,
                        numberOr(top.get("sentAt"), -1), -1);
            }
            case TYPE_PING:
            case TYPE_PONG:
                return new Frame(type, null, null, null, null, null, null, -1, -1, numberOr(top.get("t"), 0));
            default:
                return null;
        }
    }

    /**
     * The top-level {@code "key": value} pairs of one JSON object, values left as raw text.
     *
     * <p>Nested objects and arrays are skipped by balance, and string literals are skipped with
     * awareness of escapes, so a nested {@code "type"} cannot be mistaken for the frame's own. A
     * hand-written scanner rather than {@code org.json} on purpose: {@code org.json} is a stub under
     * a JVM unit test, and this file's whole value is that it is testable without a device.
     */
    private static Map<String, String> topLevel(String text) {
        Map<String, String> out = new HashMap<>();
        int n = text.length();
        int i = skipWs(text, 0);
        if (i >= n || text.charAt(i) != '{') throw new IllegalArgumentException("not an object");
        i++;
        while (true) {
            i = skipWs(text, i);
            if (i >= n) throw new IllegalArgumentException("truncated");
            char c = text.charAt(i);
            if (c == '}') return out;
            if (c == ',') {
                i++;
                continue;
            }
            if (c != '"') throw new IllegalArgumentException("expected a key");
            int[] after = new int[1];
            String key = readString(text, i, after);
            i = skipWs(text, after[0]);
            if (i >= n || text.charAt(i) != ':') throw new IllegalArgumentException("expected ':'");
            i = skipWs(text, i + 1);
            int start = i;
            i = skipValue(text, i);
            out.put(key, text.substring(start, i));
        }
    }

    /** Skips one value; returns the index just past it. */
    private static int skipValue(String text, int i) {
        int n = text.length();
        if (i >= n) throw new IllegalArgumentException("missing value");
        char c = text.charAt(i);
        if (c == '"') {
            int[] after = new int[1];
            readString(text, i, after);
            return after[0];
        }
        if (c == '{' || c == '[') {
            int depth = 0;
            while (i < n) {
                char d = text.charAt(i);
                if (d == '"') {
                    int[] after = new int[1];
                    readString(text, i, after);
                    i = after[0];
                    continue;
                }
                if (d == '{' || d == '[') depth++;
                else if (d == '}' || d == ']') {
                    depth--;
                    if (depth == 0) return i + 1;
                }
                i++;
            }
            throw new IllegalArgumentException("unbalanced value");
        }
        while (i < n) {
            char d = text.charAt(i);
            if (d == ',' || d == '}' || d == ']' || d == ' ' || d == '\t') return i;
            i++;
        }
        return i;
    }

    private static int skipWs(String text, int i) {
        while (i < text.length() && Character.isWhitespace(text.charAt(i))) i++;
        return i;
    }

    /** Reads the string literal that starts at {@code i} (the opening quote); sets {@code after[0]}. */
    private static String readString(String text, int i, int[] after) {
        int n = text.length();
        if (i >= n || text.charAt(i) != '"') throw new IllegalArgumentException("not a string");
        StringBuilder out = new StringBuilder();
        int j = i + 1;
        while (j < n) {
            char c = text.charAt(j++);
            if (c == '"') {
                after[0] = j;
                return out.toString();
            }
            if (c != '\\') {
                out.append(c);
                continue;
            }
            if (j >= n) break;
            char e = text.charAt(j++);
            switch (e) {
                case 'n': out.append('\n'); break;
                case 't': out.append('\t'); break;
                case 'r': out.append('\r'); break;
                case 'b': out.append('\b'); break;
                case 'f': out.append('\f'); break;
                case 'u':
                    if (j + 4 > n) throw new IllegalArgumentException("truncated escape");
                    out.append((char) Integer.parseInt(text.substring(j, j + 4), 16));
                    j += 4;
                    break;
                default: out.append(e);
            }
        }
        throw new IllegalArgumentException("unterminated string");
    }

    private static String string(String raw) {
        if (raw == null || raw.length() < 2 || raw.charAt(0) != '"') return null;
        int[] after = new int[1];
        try {
            return readString(raw, 0, after);
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** An integer, or {@code fallback}. Refuses anything JSON would have typed as non-integer. */
    private static long longOr(String raw, long fallback) {
        if (raw == null || raw.isEmpty()) return fallback;
        int i = raw.charAt(0) == '-' ? 1 : 0;
        if (i >= raw.length()) return fallback;
        long value = 0;
        for (; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (c < '0' || c > '9') return fallback;
            value = value * 10 + (c - '0');
        }
        return raw.charAt(0) == '-' ? -value : value;
    }

    /** A finite number (an integer or a decimal), or {@code fallback}. */
    private static long numberOr(String raw, long fallback) {
        if (raw == null || raw.isEmpty()) return fallback;
        String body = raw.charAt(0) == '-' ? raw.substring(1) : raw;
        if (body.isEmpty() || body.charAt(0) == '.') return fallback;
        for (int i = 0; i < body.length(); i++) {
            char c = body.charAt(i);
            if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
                try {
                    return (long) Double.parseDouble(raw);
                } catch (NumberFormatException e) {
                    return fallback;
                }
            }
            if (c < '0' || c > '9') return fallback;
        }
        return longOr(raw, fallback);
    }

    private static int[] intArray(String raw) {
        if (raw == null || raw.length() < 2 || raw.charAt(0) != '[' || raw.charAt(raw.length() - 1) != ']') {
            return null;
        }
        String body = raw.substring(1, raw.length() - 1).trim();
        List<Integer> out = new ArrayList<>();
        if (!body.isEmpty()) {
            for (String part : body.split(",")) {
                long v = longOr(part.trim(), Long.MIN_VALUE);
                if (v == Long.MIN_VALUE) return null;
                out.add((int) v);
            }
        }
        int[] values = new int[out.size()];
        for (int i = 0; i < values.length; i++) values[i] = out.get(i);
        return values;
    }

    // --- encoding -------------------------------------------------------------------------------

    /** {@code { "v":1, "type":"hello", "role":…, "proto":[…], "sentAt":… }}. */
    public static String encodeHello(String role, long sentAt, int[] proto) {
        StringBuilder list = new StringBuilder("[");
        if (proto != null) {
            for (int i = 0; i < proto.length; i++) {
                if (i > 0) list.append(',');
                list.append(proto[i]);
            }
        }
        list.append(']');
        return "{\"v\":" + PROTOCOL_VERSION + ",\"type\":\"" + TYPE_HELLO + "\",\"role\":\"" + quote(role)
                + "\",\"proto\":" + list + ",\"sentAt\":" + sentAt + "}";
    }

    /** {@code { "v":1, "type":"ack", "id":…, "result":…, "reason":…, "rev":…, "sentAt":… }}. */
    public static String encodeAck(String id, String result, String reason, long rev, long sentAt) {
        return "{\"v\":" + PROTOCOL_VERSION + ",\"type\":\"" + TYPE_ACK + "\",\"id\":\"" + quote(id)
                + "\",\"result\":\"" + quote(result) + "\",\"reason\":"
                + (reason == null ? "null" : "\"" + quote(reason) + "\"")
                + ",\"rev\":" + rev + ",\"sentAt\":" + sentAt + "}";
    }

    /** {@code { "v":1, "type":"pong", "t":… }}. */
    public static String encodePong(long t) {
        return "{\"v\":" + PROTOCOL_VERSION + ",\"type\":\"" + TYPE_PONG + "\",\"t\":" + t + "}";
    }

    private static String quote(String text) {
        if (text == null) return "";
        StringBuilder out = new StringBuilder(text.length() + 8);
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
                    else out.append(c);
            }
        }
        return out.toString();
    }
}
