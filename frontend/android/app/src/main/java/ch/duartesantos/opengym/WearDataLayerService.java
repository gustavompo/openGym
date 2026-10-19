package ch.duartesantos.opengym;

import android.util.Log;
import com.google.android.gms.wearable.DataEventBuffer;
import com.google.android.gms.wearable.MessageEvent;
import com.google.android.gms.wearable.Node;
import com.google.android.gms.wearable.WearableListenerService;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * The Data Layer entry point, and the reason decision 3 exists at all.
 *
 * <p>Android freezes openGym's process about 50 s after it stops being visible
 * ({@code docs/notes/02-webview-background-liveness.md} — measured: {@code isFrozen=true}, cgroup
 * {@code cpu:/background}, one recorded 490 s gap with zero JS callbacks). A frozen process runs no
 * JS, no Capacitor bridge and no {@code accept()} on its own sockets. This service is the one
 * component AMS will unfreeze the process for, so it is where the watch has to be answered from.
 *
 * <p>It is also why nothing here needs JS: {@link WearLink} answers a {@code hello} and a
 * {@code ping} from native code and the persisted cache, and only a {@code command} — which must go
 * through openGym's own store actions — is handed on.
 *
 * <p>Declared in the manifest with the {@code MESSAGE_RECEIVED} and {@code DATA_CHANGED} filters on
 * {@code /opengym/wear}. The filters carry the path so Play services wakes us for our own traffic;
 * the handlers check it again, because a filter is not a guarantee. It has to be
 * {@code android:exported="true"}: Play services is another app, and an exported component is the
 * only way it can deliver anything here. There is no permission on it and there is nothing to
 * protect — every path but ours is ignored, and no frame can do anything except move the phone's own
 * workout forward through JS, which the phone's own buttons do too.
 */
public class WearDataLayerService extends WearableListenerService {

    private static final String TAG = "WearDataLayerService";

    @Override
    public void onCreate() {
        super.onCreate();
        // Loads the persisted cache before the first frame arrives: a `hello` that lands in the same
        // wake-up as this service must not be answered with "nothing to report".
        WearLink.install(getApplicationContext());
    }

    @Override
    public void onMessageReceived(MessageEvent event) {
        if (event == null || !WearWire.PATH.equals(event.getPath())) return;
        byte[] data = event.getData();
        if (data == null || data.length == 0 || data.length > WearWire.MAX_FRAME_CHARS) return;
        String frame = new String(data, StandardCharsets.UTF_8);
        Log.i(TAG, "message from " + event.getSourceNodeId() + " (" + frame.length() + " chars)");
        WearLink.get(getApplicationContext()).onInbound(event.getSourceNodeId(), frame);
    }

    @Override
    public void onDataChanged(DataEventBuffer events) {
        // `state` is the phone's to send and travels as a DataItem (§1); a watch has no reason to
        // write one, but the filter is declared and the path is ours, so it is read the same way a
        // message is rather than silently dropped. The source node is unknown for a data event: the
        // URI carries the writing node, which is the watch here.
        for (String frame : WearDataLayer.framesOf(events)) {
            Log.i(TAG, "data item on " + WearWire.PATH + " (" + frame.length() + " chars)");
            WearLink.get(getApplicationContext()).onInbound(null, frame);
        }
    }

    @Override
    public void onConnectedNodes(List<Node> connected) {
        List<String> ids = new ArrayList<>();
        if (connected != null) for (Node node : connected) ids.add(node.getId());
        WearLink.get(getApplicationContext()).onConnectedNodes(ids);
    }

    @Override
    public void onPeerConnected(Node node) {
        if (node == null) return;
        WearLink.get(getApplicationContext()).onNodeConnected(node.getId());
    }

    @Override
    public void onPeerDisconnected(Node node) {
        if (node == null) return;
        WearLink.get(getApplicationContext()).onNodeDisconnected(node.getId());
    }
}
