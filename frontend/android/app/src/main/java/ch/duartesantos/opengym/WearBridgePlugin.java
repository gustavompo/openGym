package ch.duartesantos.opengym;

import android.content.Context;
import android.content.Intent;
import android.util.Log;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The TCP relay of the phone ↔ watch link (docs/protocol.md §7).
 *
 * This class is a dumb, framing-only pipe: one JSON object per line, UTF-8, terminated by {@code
 * \n}. It does not parse the frames and it holds no protocol state — {@code
 * frontend/src/lib/wear-link.js} owns version negotiation, revisions and acknowledgements, and
 * {@code docs/protocol.md} is the contract both sides implement. Keeping the split there is what
 * lets the identical bytes travel the Wear OS Data Layer later (M3.4) without touching the JS.
 *
 * The phone LISTENS and the watch CONNECTS:
 *
 * <pre>
 *   phone: ServerSocket 0.0.0.0:8765  &lt;-- adb forward tcp:8765 tcp:8765 &lt;--  10.0.2.2:8765
 * </pre>
 *
 * One watch per connection; a second connection replaces the first. This exists because the Data
 * Layer cannot be exercised on two emulators without a Google account on each (docs/plan.md §1.4),
 * and it is a development transport, not a substitute for the Data Layer's wake path.
 *
 * Usage from JS:
 * <pre>
 *   const WearBridge = registerPlugin('WearBridge');
 *   WearBridge.addListener('frame', e =&gt; e.text);   // one line, decoded by the caller
 *   WearBridge.addListener('link',  e =&gt; e.connected);
 *   await WearBridge.start({ port: 8765 });
 *   await WearBridge.send({ frame: '{"v":1,...}' });  // one line, without the newline
 *   await WearBridge.status();
 * </pre>
 *
 * Frames that arrive before the page has registered its {@code frame} listener are retained by
 * Capacitor ({@code notifyListeners(..., retainUntilConsumed = true)}) rather than dropped: the
 * socket can be up — and the watch can send its {@code hello} — before the WebView has booted.
 * Nothing is exported to other apps and no permission is asked for beyond {@code INTERNET}.
 */
@CapacitorPlugin(name = "WearBridge")
public class WearBridgePlugin extends Plugin implements WearLink.FrameSink {

    private static final String TAG = "WearBridge";

    /** docs/protocol.md §7. */
    public static final int DEFAULT_PORT = 8765;

    /** A frame is a small JSON object; anything larger is a mistake and is dropped, not buffered. */
    private static final int MAX_FRAME_CHARS = 64 * 1024;

    /** Guards {@link #server}, {@link #client}, {@link #writer} and {@link #remote}. */
    private final Object lock = new Object();

    private ServerSocket server;
    private Socket client;
    private BufferedWriter writer;
    private volatile boolean listening;
    private volatile boolean destroyed;
    private volatile int port = DEFAULT_PORT;
    private volatile String remote;
    private final AtomicLong received = new AtomicLong();
    private final AtomicLong sent = new AtomicLong();

    @Override
    public void load() {
        super.load();
        // The Data Layer carrier is the same frames on a second pipe: the plugin is the choke point
        // both of them go through, so nothing above this class knows which one carried anything.
        // Decision 3: the native copy of the newest `state` frame is kept from here, and the
        // WearableListenerService answers `hello` from it while the WebView is frozen.
        WearLink.install(getContext());
        WearLink link = WearLink.get(getContext());
        if (link != null) {
            link.attach(this);
            // Nodes already connected before the page booted (the ordinary case: the watch was up
            // first) are learned here rather than waiting for something to arrive from them.
            link.refreshNodes();
        }
    }

    @Override
    protected void handleOnDestroy() {
        destroyed = true;
        WearLink link = WearLink.peek();
        if (link != null) link.detach(this);
        stopListening();
        super.handleOnDestroy();
    }

    /** A frame from either carrier, on the same event the TCP relay has always used. */
    @Override
    public void onFrame(String text) {
        notifyFrame(text);
    }

    // --- plugin methods --------------------------------------------------------------------------

    /** Starts listening. Idempotent: a second call keeps the running socket and just reports it. */
    @PluginMethod
    public void start(PluginCall call) {
        int wanted = call.getInt("port", DEFAULT_PORT);
        if (wanted < 1024 || wanted > 65535) {
            call.reject("port out of range");
            return;
        }
        synchronized (lock) {
            if (listening) {
                JSObject out = new JSObject();
                out.put("listening", true);
                out.put("port", port);
                call.resolve(out);
                return;
            }
            port = wanted;
        }
        if (!openServer()) {
            call.reject("could not listen on port " + wanted);
            return;
        }
        JSObject out = new JSObject();
        out.put("listening", true);
        out.put("port", port);
        call.resolve(out);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopListening();
        call.resolve();
    }

    /**
     * Writes one frame and its newline over TCP, and hands the same frame to the Wear OS Data Layer.
     * Resolves {@code sent:false} — not an error — when no watch is attached to the TCP relay, which
     * is the ordinary case: the caller keeps the frame and sends the current state again to the next
     * connection (protocol §7).
     *
     * <p>`sent` still means the TCP relay, because that is the field the JS has always read and the
     * emulator rig depends on. `datalayer` reports the other carrier separately; a `state` frame is
     * cached for the listener service whether or not either carrier has a peer.
     */
    @PluginMethod
    public void send(PluginCall call) {
        String frame = call.getString("frame");
        if (frame == null) {
            call.reject("frame is required");
            return;
        }
        if (frame.indexOf('\n') >= 0 || frame.length() > MAX_FRAME_CHARS) {
            // One JSON object per line is the whole framing rule; a newline inside a frame would
            // split it into two unparseable frames on the far side.
            call.reject("frame must be a single line");
            return;
        }
        boolean ok = writeFrame(frame);
        WearLink link = WearLink.get(getContext());
        boolean cached = false;
        if (link != null) {
            link.onJsFrame(frame);
            cached = WearWire.TYPE_STATE.equals(typeOf(frame));
        }
        JSObject out = new JSObject();
        out.put("sent", ok);
        out.put("datalayer", link != null && link.nodeCount() > 0);
        out.put("cached", cached);
        call.resolve(out);
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject out = new JSObject();
        out.put("listening", listening);
        out.put("port", port);
        out.put("connected", remote != null);
        out.put("remote", remote);
        out.put("received", received.get());
        out.put("sent", sent.get());
        // What native code knows on its own — the part that has to answer while the WebView is
        // frozen. `stateAgeMs` is the honest staleness of the cache. `jsAttached` false means every
        // command from the watch would be refused rather than faked.
        WearLink link = WearLink.get(getContext());
        if (link != null) {
            for (Map.Entry<String, Object> entry : link.snapshot().entrySet()) {
                out.put(entry.getKey(), entry.getValue());
            }
        }
        out.put("session", WearSessionService.isRunning());
        call.resolve(out);
    }

    /**
     * Starts or stops the workout-scoped foreground service (M4.7). Called by
     * `lib/wear-session.js` at the moment the projection gains or loses a workout.
     *
     * <p>`active:true` from a background thread would be refused by Android 12+, which is why the
     * page only ever calls it while the user is looking at it — a workout starts on screen.
     */
    @PluginMethod
    public void session(PluginCall call) {
        Context ctx = getContext();
        if (ctx == null) {
            call.reject("no context");
            return;
        }
        boolean active = Boolean.TRUE.equals(call.getBoolean("active", Boolean.FALSE));
        Intent intent = new Intent(ctx, WearSessionService.class);
        intent.setAction(WearSessionService.ACTION_SESSION);
        intent.putExtra(WearSessionService.EXTRA_ACTIVE, active);
        intent.putExtra(WearSessionService.EXTRA_TITLE, call.getString("title"));
        boolean started = true;
        try {
            if (active) ContextCompat.startForegroundService(ctx, intent);
            else ctx.startService(intent);
        } catch (Exception e) {
            Log.w(TAG, "could not " + (active ? "start" : "stop") + " the session service", e);
            started = false;
        }
        JSObject out = new JSObject();
        out.put("started", started);
        out.put("running", WearSessionService.isRunning());
        call.resolve(out);
    }

    /**
     * Brings the watch app to the front (M8, docs/notes/26). The only thing the Data Layer cannot
     * do; the trigger *policy* lives in JS (`lib/wear-launch.js`), not here — this method just asks.
     */
    @PluginMethod
    public void launch(PluginCall call) {
        Context ctx = getContext();
        if (ctx == null) {
            call.reject("no context");
            return;
        }
        WearLink link = WearLink.get(ctx);
        int attempted = link == null ? 0 : link.launchWatch();
        JSObject out = new JSObject();
        out.put("requested", true);
        out.put("attempted", attempted);
        out.put("nodes", link == null ? 0 : link.nodeCount());
        call.resolve(out);
    }

    /**
     * The frame's {@code type}, or null when it does not decode. Used only to report {@code cached}
     * from {@link #send}; the caching itself happens in {@link WearLink#onJsFrame}.
     */
    private static String typeOf(String frame) {
        WearWire.Frame parsed = WearWire.parse(frame);
        return parsed == null ? null : parsed.type;
    }

    // --- server ----------------------------------------------------------------------------------

    private boolean openServer() {
        ServerSocket candidate = null;
        try {
            candidate = new ServerSocket();
            candidate.setReuseAddress(true);
            // 0.0.0.0 so the watch emulator can reach it through 10.0.2.2 as well as through
            // `adb forward tcp:8765 tcp:8765`, which arrives on the loopback.
            candidate.bind(new InetSocketAddress("0.0.0.0", port), 4);
        } catch (IOException e) {
            Log.w(TAG, "bind failed on " + port, e);
            closeQuietly(candidate);
            return false;
        }
        synchronized (lock) {
            server = candidate;
            listening = true;
        }
        Thread accept = new Thread(this::acceptLoop, "wear-bridge-accept");
        accept.setDaemon(true);
        accept.start();
        Log.i(TAG, "listening on 0.0.0.0:" + port);
        return true;
    }

    private void acceptLoop() {
        ServerSocket ss;
        synchronized (lock) {
            ss = server;
        }
        while (listening && ss != null && !ss.isClosed()) {
            Socket accepted;
            try {
                accepted = ss.accept();
            } catch (IOException e) {
                break; // closing the ServerSocket is how this loop ends
            }
            attach(accepted);
        }
        synchronized (lock) {
            listening = false;
        }
    }

    private void attach(Socket socket) {
        BufferedReader reader;
        BufferedWriter out;
        try {
            socket.setTcpNoDelay(true);
            reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
            out = new BufferedWriter(new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8));
        } catch (IOException e) {
            Log.w(TAG, "could not open the accepted socket", e);
            closeQuietly(socket);
            return;
        }
        // One watch at a time: a second connection replaces the first (protocol §7).
        synchronized (lock) {
            closeClient();
            client = socket;
            writer = out;
            remote = String.valueOf(socket.getRemoteSocketAddress());
        }
        Log.i(TAG, "watch connected: " + remote);
        notifyLink(true);

        Thread read = new Thread(() -> readLoop(socket, reader), "wear-bridge-read");
        read.setDaemon(true);
        read.start();
    }

    private void readLoop(Socket socket, BufferedReader reader) {
        try {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isEmpty()) continue;
                if (line.length() > MAX_FRAME_CHARS) {
                    Log.w(TAG, "dropping an oversized frame (" + line.length() + " chars)");
                    continue;
                }
                received.incrementAndGet();
                notifyFrame(line);
            }
        } catch (IOException e) {
            Log.d(TAG, "read ended: " + e.getMessage());
        } finally {
            boolean wasCurrent;
            synchronized (lock) {
                wasCurrent = client == socket;
                if (wasCurrent) {
                    closeClient();
                    remote = null;
                }
            }
            // A replaced connection must not report "disconnected" over the new one.
            if (wasCurrent) {
                Log.i(TAG, "watch disconnected");
                notifyLink(false);
            }
        }
    }

    private boolean writeFrame(String frame) {
        synchronized (lock) {
            if (writer == null) return false;
            try {
                writer.write(frame);
                writer.newLine();
                writer.flush();
                sent.incrementAndGet();
                return true;
            } catch (IOException e) {
                Log.w(TAG, "write failed, dropping the connection", e);
                closeClient();
                remote = null;
            }
        }
        notifyLink(false);
        return false;
    }

    private void stopListening() {
        Socket toClose;
        ServerSocket toCloseServer;
        synchronized (lock) {
            listening = false;
            toCloseServer = server;
            server = null;
            toClose = client;
            closeClient();
            remote = null;
        }
        closeQuietly(toCloseServer);
        closeQuietly(toClose);
    }

    /** Callers hold {@link #lock}. */
    private void closeClient() {
        closeQuietly(client);
        client = null;
        writer = null;
    }

    private static void closeQuietly(java.io.Closeable c) {
        if (c == null) return;
        try {
            c.close();
        } catch (IOException ignored) {
            // Nothing to do: closing is how we are already giving up on it.
        }
    }

    // --- events ----------------------------------------------------------------------------------

    /** Retained until the page listens, so a `hello` sent before the WebView boots is not lost. */
    private void notifyFrame(String text) {
        if (destroyed) return;
        try {
            JSObject data = new JSObject();
            data.put("text", text);
            notifyListeners("frame", data, true);
        } catch (RuntimeException e) {
            Log.w(TAG, "could not hand the frame to the page", e);
        }
    }

    private void notifyLink(boolean connected) {
        if (destroyed) return;
        try {
            JSObject data = new JSObject();
            data.put("connected", connected);
            data.put("remote", remote);
            notifyListeners("link", data, true);
        } catch (RuntimeException e) {
            Log.w(TAG, "could not hand the link state to the page", e);
        }
    }
}
