package ch.duartesantos.opengym;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

/**
 * Foreground for as long as a workout is running — M4.7, and a correctness requirement rather than a
 * nicety.
 *
 * <p>What it prevents is measured, not assumed: ~50 s after openGym stops being visible Android's
 * {@code CachedAppOptimizer} freezes the whole process ({@code isFrozen=true}, cgroup
 * {@code 2:cpu:/background}), and a frozen process executes no JS at all — one recorded stall was
 * 490 s with zero timer callbacks ({@code docs/notes/02-webview-background-liveness.md}). The seven
 * commands must go through openGym's own store actions, which live in JS, so without this service a
 * workout in progress would have the WebView frozen and every watch command would have to be
 * refused. With it, the process is never a cached app and the freeze never happens.
 *
 * <p>Scoped to a workout, like {@code RestTimerService} is scoped to a rest: it starts when a
 * workout becomes active and stops when it ends, and the notification goes with it. There is no
 * permanent notification and no wake lock — the point is the process's priority, not keeping the CPU
 * awake, and holding one for a whole session would be a real battery cost for nothing. The rest
 * countdown still holds its own wake lock for its own last second.
 *
 * <p>Started and stopped by the page through {@code lib/wear-session.js} at the same choke point
 * that publishes state, so the two cannot disagree: whatever the projection says a workout is, that
 * is what the service is doing.
 */
public class WearSessionService extends Service {

    private static final String TAG = "WearSession";

    static final String ACTION_SESSION = "ch.duartesantos.opengym.action.WEAR_SESSION";
    static final String EXTRA_ACTIVE = "active";
    static final String EXTRA_TITLE = "title";

    /**
     * Neither of the two the rest owns: {@code RestAlert.COUNTDOWN_ID} is 41 and
     * {@code RestAlert.NOTIFICATION_ID} (the rest's-over card) is 42. This was 42, which meant the
     * end of every rest during a workout replaced this service's ongoing notification with the
     * rest's-over card — asked for by {@code lib/rest-alert.js} as {@code REST_ALERT_ID} — and that
     * card is {@code autoCancel}, so dismissing it left the service with no notification at all.
     */
    static final int NOTIFICATION_ID = 43;
    static final String CHANNEL_ID = "wear-workout-session";

    private static volatile boolean running;

    /** Whether the process is foreground for a workout right now. Read by `status()`. */
    public static boolean isRunning() {
        return running;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (!ACTION_SESSION.equals(action)) {
            // Not ours (the system re-creating a null-intent start, say): leave the state alone.
            return START_NOT_STICKY;
        }
        if (!intent.getBooleanExtra(EXTRA_ACTIVE, false)) {
            running = false;
            stopForegroundCompat();
            stopSelf();
            return START_NOT_STICKY;
        }
        running = true;
        show(intent.getStringExtra(EXTRA_TITLE));
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        stopForegroundCompat();
        super.onDestroy();
    }

    private void show(String title) {
        try {
            String text = getString(R.string.wear_session_text);
            if (title == null || title.trim().isEmpty()) title = getString(R.string.wear_session_title);
            ensureChannel();
            Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(this, CHANNEL_ID)
                    : new Notification.Builder(this);
            builder.setSmallIcon(R.drawable.ic_stat_dumbbell)
                    .setContentTitle(title)
                    .setContentText(text)
                    .setShowWhen(false)
                    .setOngoing(true)
                    .setOnlyAlertOnce(true)
                    .setLocalOnly(true)
                    .setCategory(Notification.CATEGORY_SERVICE)
                    .setVisibility(Notification.VISIBILITY_PUBLIC)
                    .setContentIntent(openApp());
            if (Build.VERSION.SDK_INT >= 31) {
                // Otherwise Android holds the first foreground-service notification back for ten
                // seconds, which for a workout that is already running reads as "nothing happened".
                builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
            }
            if (Build.VERSION.SDK_INT < 26) builder.setPriority(Notification.PRIORITY_LOW);
            Notification notification = builder.build();
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (Exception e) {
            // Android 12+ can refuse a background start. The workout continues; the freeze does not
            // get prevented, which is the honest outcome — the page is told `running: false`.
            Log.w(TAG, "could not go foreground", e);
            running = false;
            stopSelf();
        }
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, getString(R.string.wear_session_channel_name), NotificationManager.IMPORTANCE_LOW);
        channel.setDescription(getString(R.string.wear_session_channel_desc));
        channel.setSound(null, null);
        channel.enableVibration(false);
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private PendingIntent openApp() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = Build.VERSION.SDK_INT >= 23
                ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                : PendingIntent.FLAG_UPDATE_CURRENT;
        return PendingIntent.getActivity(this, 0, open, flags);
    }

    @SuppressWarnings("deprecation")
    private void stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
    }
}
