package ch.duartesantos.opengym;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;
import androidx.wear.remote.interactions.RemoteActivityHelper;
import com.google.common.util.concurrent.ListenableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;

/**
 * Brings the watch app to the front from the phone — the one thing the Data Layer cannot do.
 *
 * <p>A {@code Message} or a {@code DataItem} has no activity-start privilege, and an ordinary
 * background activity start from a peer is blocked from API 29 on. The sanctioned mechanism is
 * {@code androidx.wear:wear-remote-interactions}'
 * {@link RemoteActivityHelper#startRemoteActivity}: the intent is handed to the watch through Play
 * services, which starts it there — a watch-side start, not a phone-side one.
 *
 * <p><b>Two assumptions were falsified before any hardware ran, and that is why this file reads the
 * way it does</b> (see {@code docs/notes/26-watch-autolaunch-findings.md}):
 *
 * <ol>
 *   <li>{@code RemoteActivityHelper} is <b>not</b> in {@code play-services-wearable}. It lives in
 *       {@code androidx.wear:wear-remote-interactions} (verified against the AAR in the Gradle
 *       cache: 19.0.0 and 20.0.1 contain no such class). The docs' {@code com.google.android.gms}
 *       reference is the deprecated {@code com.google.android.wearable.intent.RemoteIntent}, which
 *       redirects here.
 *   <li>The intent must be {@code ACTION_VIEW} + a data URI + <b>{@code CATEGORY_BROWSABLE}</b>.
 *       Without {@code BROWSABLE} the call is rejected with an {@code IllegalArgumentException} —
 *       a silent no-op if the failure listener is not wired. Extras, package and component are
 *       stripped from the delivered intent; only action, categories and the URI arrive.
 * </ol>
 *
 * <p>What is <em>still</em> an assumption, and the whole point of the hardware probe: that this
 * actually raises the activity on a Galaxy Watch 5 Pro / Wear OS 5 in each of the four states
 * (foreground / backgrounded / screen off / force-stopped). Nothing here claims that. Findings:
 * {@code docs/notes/26-watch-autolaunch-findings.md}.
 */
public final class WearLaunch {

    public static final String TAG = "WearLaunch";

    /**
     * The path the watch app's activity filter declares. The host of a {@code wear://} URI is not
     * matched by the remote start (only scheme + path), so it is a literal {@code *}. One string per
     * side, so the watch manifest and this URI cannot drift.
     */
    public static final String PATH = "/opengym/watch";

    private static final Executor EXECUTOR = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "wear-launch");
        t.setDaemon(true);
        return t;
    });

    /** The intent the watch's Play services will start. */
    public static Intent intent() {
        return new Intent(Intent.ACTION_VIEW)
                .addCategory(Intent.CATEGORY_BROWSABLE)
                .addCategory(Intent.CATEGORY_DEFAULT)
                .setData(Uri.parse("wear://*" + PATH));
    }

    private WearLaunch() {}

    /** Launches on one node (or every watch, when {@code nodeId} is null). Never throws. */
    public static boolean launch(Context ctx, String nodeId) {
        if (ctx == null) return false;
        final String label = "wear://*" + PATH + " -> " + (nodeId == null ? "<all watches>" : nodeId);
        try {
            RemoteActivityHelper helper = new RemoteActivityHelper(ctx.getApplicationContext(), EXECUTOR);
            ListenableFuture<Void> future = helper.startRemoteActivity(intent(), nodeId);
            future.addListener(() -> {
                try {
                    future.get(); // throws when the remote start failed
                    Log.i(TAG, "started " + label);
                } catch (Exception e) {
                    Log.w(TAG, "start failed " + label + ": " + e);
                }
            }, EXECUTOR);
            Log.i(TAG, "start requested " + label);
            return true;
        } catch (Exception e) {
            // The documented rejection: a missing CATEGORY_BROWSABLE, a non-ACTION_VIEW action, or
            // no data URI throws IllegalArgumentException here, synchronously.
            Log.w(TAG, "start could not even be attempted " + label + ": " + e);
            return false;
        }
    }
}
