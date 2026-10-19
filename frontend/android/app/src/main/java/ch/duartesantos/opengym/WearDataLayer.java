package ch.duartesantos.opengym;

import android.content.Context;
import android.util.Log;
import com.google.android.gms.wearable.DataEvent;
import com.google.android.gms.wearable.DataEventBuffer;
import com.google.android.gms.wearable.DataItem;
import com.google.android.gms.wearable.MessageClient;
import com.google.android.gms.wearable.Node;
import com.google.android.gms.wearable.PutDataRequest;
import com.google.android.gms.wearable.Wearable;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * The Play services calls behind the Wear OS Data Layer carrier: nodes, a message per frame, and one
 * {@code DataItem} for {@code state}.
 *
 * <p>Framing is the whole of what this class knows, exactly like {@link WearBridgePlugin}'s TCP
 * socket: one frame per message, or per {@code DataItem} value at {@link WearWire#PATH} — protocol
 * §1. Which frame goes which way is a single rule and lives in {@link #sendFrame}.
 *
 * <p>Every call is wrapped: on a device without Play services (or without a paired node) these APIs
 * fail or throw, and that must be an ordinary "no carrier" rather than a crash. The Data Layer is
 * <b>unverified on this machine's emulators</b> (no Google account on either — see
 * {@code docs/notes/12-datalayer-decisions.md} §7), so the failure path is the one that actually
 * runs here.
 */
final class WearDataLayer {

    private static final String TAG = "WearDataLayer";

    interface NodeList {
        /** The connected node ids, or null when the Data Layer could not be asked at all. */
        void onNodes(List<String> nodeIds);
    }

    private WearDataLayer() {}

    /**
     * Enumerates the connected nodes once. The Data Layer addresses nodes, not addresses
     * (decision 2); the watch decides which phone to use, this side only reports.
     */
    static void connectedNodes(Context ctx, NodeList callback) {
        try {
            Wearable.getNodeClient(ctx)
                    .getConnectedNodes()
                    .addOnSuccessListener(nodes -> {
                        List<String> ids = new ArrayList<>();
                        if (nodes != null) for (Node node : nodes) ids.add(node.getId());
                        callback.onNodes(ids);
                    })
                    .addOnFailureListener(e -> {
                        Log.w(TAG, "getConnectedNodes failed: " + e);
                        callback.onNodes(null);
                    });
        } catch (Exception e) {
            Log.w(TAG, "no Data Layer here: " + e);
            callback.onNodes(null);
        }
    }

    /** One frame to one node, over {@code MessageClient}. */
    static void send(Context ctx, String nodeId, String frame) {
        if (nodeId == null || nodeId.isEmpty() || frame == null) return;
        try {
            Wearable.getMessageClient(ctx)
                    .sendMessage(nodeId, WearWire.PATH, frame.getBytes(StandardCharsets.UTF_8))
                    .addOnFailureListener(e -> Log.w(TAG, "send to " + nodeId + " failed: " + e));
        } catch (Exception e) {
            Log.w(TAG, "send to " + nodeId + " could not even be attempted: " + e);
        }
    }

    /**
     * The {@code state} frame as a {@code DataItem} (protocol §1), which is what makes the last
     * projection available to a watch that arrives after the phone stopped being able to say
     * anything: the value survives the process, and {@code sentAt}/{@code rev} inside it say how
     * stale it is. It is not addressed to a node — a data item replicates to every connected one.
     */
    static void putState(Context ctx, String frame) {
        if (frame == null) return;
        try {
            PutDataRequest request = PutDataRequest.create(WearWire.PATH).setData(frame.getBytes(StandardCharsets.UTF_8));
            Wearable.getDataClient(ctx)
                    .putDataItem(request)
                    .addOnFailureListener(e -> Log.w(TAG, "putDataItem failed: " + e));
        } catch (Exception e) {
            Log.w(TAG, "putDataItem could not even be attempted: " + e);
        }
    }

    /**
     * The one routing rule: {@code state} goes to the store **and** to each connected node;
     * everything else is just a message. {@code state} needs no nodes to be worth writing — it is
     * stored locally and reaches whoever connects next — but "whoever connects next" is not
     * "whoever is listening now", and a node that is already listening would otherwise wait for a
     * round trip through the store for a frame the phone could hand it directly.
     *
     * <p>Both carriers on purpose ({@code docs/notes/12-datalayer-decisions.md} §1a). The duplicate
     * is harmless by design: the protocol's {@code rev} high-water mark (protocol §5.2) makes the
     * second copy of the same frame a no-op on the watch, which is the property that lets the
     * durable carrier and the live one coexist. Do not "fix" the duplication.
     */
    static void sendFrame(Context ctx, String frame, List<String> nodes) {
        WearWire.Frame parsed = WearWire.parse(frame);
        if (parsed == null) return;
        if (WearWire.TYPE_STATE.equals(parsed.type)) {
            putState(ctx, frame);
        }
        for (String nodeId : nodes) send(ctx, nodeId, frame);
    }

    /** The frame text of a data event, or null when the event is a deletion or another path. */
    static String frameOf(DataEvent event) {
        if (event == null || event.getType() != DataEvent.TYPE_CHANGED) return null;
        DataItem item = event.getDataItem();
        if (item == null || item.getUri() == null) return null;
        if (!WearWire.PATH.equals(item.getUri().getPath())) return null;
        byte[] data = item.getData();
        if (data == null || data.length == 0) return null;
        if (data.length > WearWire.MAX_FRAME_CHARS) return null;
        return new String(data, StandardCharsets.UTF_8);
    }

    /** Reads a {@link DataEventBuffer} into frame texts, closing it. */
    static List<String> framesOf(DataEventBuffer events) {
        List<String> frames = new ArrayList<>();
        if (events == null) return frames;
        try {
            for (DataEvent event : events) {
                String frame = frameOf(event);
                if (frame != null) frames.add(frame);
            }
        } catch (Exception e) {
            Log.w(TAG, "could not read a data event: " + e);
        } finally {
            try {
                events.release();
            } catch (Exception ignored) {
                // Nothing to do: closing is how we are already giving up on it.
            }
        }
        return frames;
    }
}
