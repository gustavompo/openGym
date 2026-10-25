package ch.duartesantos.opengym;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;

/**
 * The phone's end of the Wear OS Data Layer carrier, and the one place where the decision in
 * {@code docs/notes/12-datalayer-decisions.md} §3/§4 is carried out.
 *
 * <p>Two carriers, one protocol. The frames are byte-identical whichever way they travel, so:
 *
 * <ul>
 *   <li>every frame JS hands to the bridge is also handed to the Data Layer, and every {@code state}
 *       frame is cached first ({@link WearStateCache}) — that cache is what answers a watch while the
 *       WebView is frozen;
 *   <li>every frame that arrives over the Data Layer is delivered to JS on the same Capacitor
 *       {@code frame} event the TCP socket uses, so {@code lib/wear-link.js} cannot tell the two
 *       apart and needs no carrier-specific code;
 *   <li><b>plus</b>, when the frame is one native code can answer on its own, it does: {@code hello}
 *       (with the cached state), {@code ping} (with {@code pong}). A frozen WebView cannot stop
 *       those, which is the entire point;
 *   <li>a {@code command} is not one of those. It is handed to JS, and if JS cannot answer in time
 *       it is refused with the protocol's own {@code rejected} ack rather than faked.
 * </ul>
 *
 * <p>Duplication is deliberate and harmless: a live page answers {@code hello} and publishes state
 * as well, so a watch may see two copies. The protocol is at-least-once in both directions, a
 * {@code state} is discarded by the watch's {@code rev} high-water mark (§5.2), and two identical
 * acks for one id are the same answer twice. One carrier answering first is far better than neither
 * answering at all.
 *
 * <p>This class holds no protocol state of its own: {@code rev}, the projection and the applied-id
 * log stay in JS, where they always were.
 */
public final class WearLink {

    private static final String TAG = "WearLink";

    /** How a frame reaches the page. Implemented by the Capacitor plugin. */
    public interface FrameSink {
        void onFrame(String text);
    }

    /**
     * How long a command handed to JS may go unanswered before native code refuses it.
     *
     * <p>Generous on purpose. When the process was just unfrozen for this delivery, the WebView
     * renderer is resumable and answers in milliseconds — the measurement in
     * {@code docs/notes/02-webview-background-liveness.md} is a 1.5 ms CDP round trip with the page
     * hidden. This timeout only ever fires when there is genuinely no JS running.
     */
    static final long JS_ACK_TIMEOUT_MS = 3000;

    private static final int TRACE_LIMIT = 40;
    private static WearLink singleton;

    /** The single instance for this process; created by the plugin or by the listener service. */
    public static synchronized WearLink get(Context ctx) {
        if (singleton == null && ctx != null) singleton = new WearLink(ctx.getApplicationContext());
        return singleton;
    }

    /** The instance if one exists, without creating it. */
    public static synchronized WearLink peek() {
        return singleton;
    }

    /** Making sure the cache is loaded even before any frame arrives, so a boot does not lose it. */
    public static void install(Context ctx) {
        get(ctx);
    }

    private final Context app;
    private final WearStateCache cache;
    private final WearNodeSet nodes = new WearNodeSet();
    private final Handler handler;
    private final Map<String, Runnable> awaitingAck = new HashMap<>();
    private final LinkedList<String> trace = new LinkedList<>();
    private volatile FrameSink sink;

    private WearLink(Context app) {
        this.app = app;
        this.handler = new Handler(Looper.getMainLooper());
        this.cache = new WearStateCache(new File(app.getFilesDir(), WearStateCache.FILE_NAME));
    }

    // --- the page ---------------------------------------------------------------------------------

    /** Registers the live page. Only one exists: the WebView whose bridge loaded this plugin. */
    public void attach(FrameSink frameSink) {
        sink = frameSink;
    }

    public void detach(FrameSink frameSink) {
        if (sink == frameSink) sink = null;
    }

    /** Whether there is a page to hand a command to. False is the case the refusal path exists for. */
    public boolean jsAttached() {
        return sink != null;
    }

    // --- carriers ---------------------------------------------------------------------------------

    /**
     * A frame JS just sent, whatever it is: {@code hello}, {@code state}, {@code ack}, {@code pong}.
     * The single choke point for both carriers, exactly as {@code store/useStore.js}'s {@code persist}
     * is the single choke point for the document.
     */
    public void onJsFrame(String text) {
        WearWire.Frame frame = WearWire.parse(text);
        if (frame == null) return;
        if (WearWire.TYPE_STATE.equals(frame.type)) {
            // Cached before it is sent: if the process is frozen the instant after this tap, the
            // frame the watch needs is already on disk. Never `opengym-state.json` (decision 3).
            cache.save(text, frame.rev, frame.sentAt >= 0 ? frame.sentAt : System.currentTimeMillis());
            note("js state rev=" + frame.rev);
        } else if (WearWire.TYPE_ACK.equals(frame.type)) {
            // The page answered a command it was handed: nothing is left to refuse.
            clearAckWatch(frame.id);
            note("js ack " + frame.id + " " + frame.result);
        } else if (WearWire.TYPE_HELLO.equals(frame.type)) {
            note("js hello");
        }
        WearDataLayer.sendFrame(app, text, nodes.ids());
    }

    /** A frame that arrived over a carrier. {@code nodeId} is null when the carrier has no node. */
    public void onInbound(String nodeId, String text) {
        if (text == null) return;
        if (nodeId != null) nodes.add(nodeId);
        final WearWire.Frame frame = WearWire.parse(text);
        switch (WearLinkPolicy.decide(frame, jsAttached())) {
            case SERVE_HELLO_AND_STATE:
                note("in hello from " + nodeId);
                serveHelloAndState(nodeId);
                break;
            case PONG:
                note("in ping from " + nodeId);
                WearDataLayer.send(app, nodeId, WearWire.encodePong(frame.t));
                break;
            case HAND_TO_JS:
                handToJs(text, nodeId, frame.id);
                break;
            case REJECT_COMMAND:
                note("in command " + frame.id + " with no js: refused");
                refuse(nodeId, frame);
                break;
            default:
                note("ignored: " + (frame == null ? "unparseable" : frame.type));
        }
        // The page sees the same bytes it would see on the TCP relay, so the two carriers are
        // indistinguishable to `lib/wear-link.js`: negotiation, `rev` handling and the applied-id log
        // all keep working unchanged. When native code answered as well, the watch gets the same
        // answer twice, which the protocol makes harmless.
        emitToJs(text);
    }

    /**
     * The load-bearing answer: our {@code hello} — which is how the watch learns the phone process
     * restarted and its {@code rev} may be lower than the last one it saw (§5.2) — followed by the
     * cached {@code state}, from native code, with no WebView involved.
     *
     * <p>No cached frame yet means the page has not published since the app was installed: the watch
     * then has a link and no state, which is exactly "no frame received yet" (§6), not an invented
     * workout.
     */
    private void serveHelloAndState(String nodeId) {
        WearDataLayer.send(app, nodeId, WearWire.encodeHello(
                WearWire.ROLE_PHONE, System.currentTimeMillis(), new int[] {WearWire.PROTOCOL_VERSION}));
        String cached = cache.frame();
        if (cached != null) {
            note("served cached state rev=" + cache.rev() + " to " + nodeId);
            // Both carriers, in this order, for the reason decision §1a gives: the item is written
            // for durability (it is what a watch that starts later reads), and the message is what
            // reaches the watch that just said hello without waiting on a store round trip. The
            // `rev` high-water mark makes the second copy a no-op.
            WearDataLayer.putState(app, cached);
            WearDataLayer.send(app, nodeId, cached);
        } else {
            note("no cached state to serve to " + nodeId);
        }
    }

    /**
     * Hands a command to the page and waits for its {@code ack}. Nothing is applied here: the seven
     * commands go through openGym's own store actions, which live in JS, and that is the whole reason
     * the watch and the phone UI cannot diverge.
     */
    private void handToJs(String text, String nodeId, String commandId) {
        FrameSink page = sink;
        if (page == null || commandId == null) {
            refuse(nodeId, WearWire.parse(text));
            return;
        }
        Runnable timeout = () -> {
            boolean unanswered;
            synchronized (awaitingAck) {
                unanswered = awaitingAck.remove(commandId) != null;
            }
            if (!unanswered) return;
            note("no js ack for " + commandId + " in " + JS_ACK_TIMEOUT_MS + "ms: refused");
            refuse(nodeId, WearWire.parse(text));
        };
        synchronized (awaitingAck) {
            awaitingAck.put(commandId, timeout);
        }
        handler.postDelayed(timeout, JS_ACK_TIMEOUT_MS);
        try {
            page.onFrame(text);
            note("to js " + commandId);
        } catch (RuntimeException e) {
            clearAckWatch(commandId);
            note("could not hand " + commandId + " to js: " + e);
            refuse(nodeId, WearWire.parse(text));
        }
    }

    /**
     * The protocol's existing {@code rejected} outcome, under the same id, so the watch's own
     * bookkeeping — one id per tap, retried with that id — keeps working. Nothing is applied and
     * nothing is faked.
     */
    private void refuse(String nodeId, WearWire.Frame command) {
        if (command == null) return;
        WearDataLayer.send(app, nodeId, WearLinkPolicy.jsUnavailableAck(command, cache.rev(), System.currentTimeMillis()));
    }

    private void clearAckWatch(String id) {
        if (id == null) return;
        Runnable pending;
        synchronized (awaitingAck) {
            pending = awaitingAck.remove(id);
        }
        if (pending != null) handler.removeCallbacks(pending);
    }

    private void emitToJs(String text) {
        FrameSink page = sink;
        if (page == null) return;
        try {
            page.onFrame(text);
        } catch (RuntimeException e) {
            Log.w(TAG, "could not hand a frame to the page", e);
        }
    }

    // --- nodes ------------------------------------------------------------------------------------

    /** A watch node appeared (or is back). Serving it is not an error path (decision 2). */
    public void onNodeConnected(String nodeId) {
        if (nodes.add(nodeId)) {
            note("node connected " + nodeId);
            serveHelloAndState(nodeId);
            relaunchIfRecent();
        }
    }

    public void onNodeDisconnected(String nodeId) {
        if (nodes.remove(nodeId)) note("node disconnected " + nodeId);
    }

    /**
     * The Data Layer's own view of who is connected, from
     * {@code WearableListenerService.onConnectedNodes}. Newly appeared nodes are served; the rest is
     * bookkeeping.
     */
    public void onConnectedNodes(List<String> connected) {
        if (connected == null) return;
        List<String> before = nodes.ids();
        nodes.replace(connected);
        for (String nodeId : nodes.ids()) {
            if (!before.contains(nodeId)) {
                note("node appeared " + nodeId);
                serveHelloAndState(nodeId);
                relaunchIfRecent();
            }
        }
    }

    /** Asks the carrier who is connected and folds the answer in. Used when the page starts. */
    public void refreshNodes() {
        WearDataLayer.connectedNodes(app, this::onConnectedNodes);
    }

    // --- launch -----------------------------------------------------------------------------------

    /** Start requests per launch: now, +3 s, +8 s. The helper reports "sent", never "opened". */
    private static final long[] LAUNCH_RETRY_DELAYS_MS = {3000L, 5000L};

    /** A watch that appears this soon after a launch request gets one more start request. */
    private static final long LAUNCH_REARM_WINDOW_MS = 120_000L;

    /** No re-arm when an attempt was made this recently: the retry chain is still running. */
    private static final long LAUNCH_REARM_QUIET_MS = 10_000L;

    private final Runnable launchRetry = this::launchAttempt;
    private int launchAttempts;
    private long launchRequestedAt;
    private long launchLastAttemptAt;

    /**
     * Brings the watch app to the front (M8, {@code docs/notes/26}; retry design {@code docs/notes/42}).
     *
     * <p>This is the one action the Data Layer itself cannot carry out: a frame reaches the watch's
     * process but has no privilege to raise its activity. {@link WearLaunch} asks the watch's own
     * Play services to do it, with a null node id so the helper enumerates connected watches at call
     * time rather than trusting this class's cached ledger, which can be stale.
     *
     * <p>The helper's future means the intent was <em>sent</em>, not that the watch app opened, so
     * a single call is one chance only. Three start requests go out (now, +3 s, +8 s); a repeat on
     * an app that is already in front is a no-op because the activity is {@code singleTop}.
     *
     * @return start requests made by this call: 0 or 1.
     */
    public int launchWatch() {
        handler.removeCallbacks(launchRetry);
        launchAttempts = 0;
        launchRequestedAt = System.currentTimeMillis();
        return launchAttempt();
    }

    /** One start request, and the next retry unless this was the last one. */
    private int launchAttempt() {
        if (launchAttempts > LAUNCH_RETRY_DELAYS_MS.length) return 0;
        int attempt = ++launchAttempts;
        launchLastAttemptAt = System.currentTimeMillis();
        boolean requested = WearLaunch.launch(app, null);
        note("launch watch attempt " + attempt + "/" + (LAUNCH_RETRY_DELAYS_MS.length + 1)
                + (requested ? " requested" : " could not be attempted"));
        if (attempt <= LAUNCH_RETRY_DELAYS_MS.length) {
            handler.postDelayed(launchRetry, LAUNCH_RETRY_DELAYS_MS[attempt - 1]);
        }
        return requested ? 1 : 0;
    }

    /**
     * A node appearing shortly after a launch request is the case a one-shot launch misses: the
     * watch was out of reach at the trigger. One extra request, not a second retry chain.
     */
    private void relaunchIfRecent() {
        long now = System.currentTimeMillis();
        if (launchRequestedAt == 0 || now - launchRequestedAt > LAUNCH_REARM_WINDOW_MS) return;
        if (now - launchLastAttemptAt < LAUNCH_REARM_QUIET_MS) return;
        launchLastAttemptAt = now;
        note("node reappeared inside the launch window: one more start request");
        WearLaunch.launch(app, null);
    }

    // --- state for the page's debug console and for the on-device evidence ------------------------

    public WearStateCache cache() {
        return cache;
    }

    public List<String> nodeIds() {
        return nodes.ids();
    }

    public int nodeCount() {
        return nodes.size();
    }

    public List<String> recentTrace() {
        synchronized (trace) {
            return new ArrayList<>(trace);
        }
    }

    private void note(String entry) {
        synchronized (trace) {
            trace.add(System.currentTimeMillis() + " " + entry);
            while (trace.size() > TRACE_LIMIT) trace.removeFirst();
        }
    }

    /** A read-only snapshot for `status()`: what native code knows with no JS involved at all. */
    public Map<String, Object> snapshot() {
        Map<String, Object> out = new HashMap<>();
        out.put("jsAttached", jsAttached());
        out.put("nodes", nodeIds());
        out.put("hasState", cache.hasFrame());
        out.put("stateRev", cache.rev());
        out.put("stateSavedAt", cache.savedAt());
        out.put("stateAgeMs", cache.hasFrame() ? System.currentTimeMillis() - cache.savedAt() : -1L);
        out.put("trace", recentTrace());
        return Collections.unmodifiableMap(out);
    }
}
