package ch.duartesantos.opengym;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;

/**
 * The native copy of the most recent {@code state} frame, persisted (decision 3 in
 * {@code docs/notes/12-datalayer-decisions.md}).
 *
 * <p>Why it exists: the workout lives in a WebView's memory, and Android freezes the whole process
 * about 50 s after openGym stops being visible ({@code docs/notes/02-webview-background-liveness.md}).
 * A {@code WearableListenerService} is the only component AMS will unfreeze the process for, so
 * "what is the workout right now" has to be answerable <b>without JS</b>. This is that answer.
 *
 * <p>It holds the frame <b>text verbatim</b>, exactly as {@code lib/wear-frames.js} encoded it, so
 * re-serving it is byte-identical to what JS sends: the {@code rev} and {@code sentAt} inside it are
 * what tell the watch how stale the answer is. Native code never re-derives the projection — the
 * frame may be a minute old and that is fine, but it is never a different frame.
 *
 * <p>Persistence is a small file in the app's private dir. It is deliberately <b>not</b>
 * {@code opengym-state.json}: that file belongs to openGym, is rewritten on every tap by its own
 * code, and reading or writing it here would put two writers on one document.
 *
 * <p>Only {@link java.io.File} is used, so the whole publish → persist → restart → serve lifecycle
 * runs in a plain JVM unit test ({@code WearStateCacheTest}).
 */
public final class WearStateCache {

    private static final String MAGIC = "opengym-wear-state/1";
    /** Beside {@code opengym-state.json}, never on top of it. */
    public static final String FILE_NAME = "wear-state-cache.txt";

    private final File file;
    private final ExecutorService writer;
    private String frame;
    private long rev = -1;
    private long savedAt = 0;

    public WearStateCache(File file) {
        this.file = file;
        this.writer = Executors.newSingleThreadExecutor(new ThreadFactory() {
            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "wear-state-cache");
                t.setDaemon(true);
                return t;
            }
        });
        load();
    }

    /** The last frame JS published through the bridge, or null. */
    public synchronized String frame() {
        return frame;
    }

    /** The {@code rev} of that frame, or -1 when there is none. */
    public synchronized long rev() {
        return rev;
    }

    public synchronized long savedAt() {
        return savedAt;
    }

    public synchronized boolean hasFrame() {
        return frame != null;
    }

    /**
     * Records one published {@code state} frame and persists it. Called on the WebView's thread, so
     * the file write goes to a worker: a disk write in the middle of a tap would be a visible stall,
     * and the in-memory copy is what a wake-up actually reads.
     */
    public void save(String frameText, long rev, long savedAt) {
        // Only a `state` frame: this class caches *the projection*, and the load path already
        // refuses anything else. Accepting an `ack` here would leave an in-memory frame that
        // disappears on the next restart, i.e. a cache that answers a `hello` differently
        // depending on how long the process has been up.
        WearWire.Frame parsed = frameText == null ? null : WearWire.parse(frameText);
        if (parsed == null || !WearWire.TYPE_STATE.equals(parsed.type)) return;
        synchronized (this) {
            this.frame = frameText;
            this.rev = rev;
            this.savedAt = savedAt;
            if (!writer.isShutdown()) writer.execute(this::persist);
        }
    }

    /**
     * Drops the cache, memory and file. Used when the workout ends: the next `hello` should answer
     * "no workout to report" by sending nothing, rather than a frame from a session that is over.
     */
    public void clear() {
        synchronized (this) {
            frame = null;
            rev = -1;
            savedAt = 0;
            if (!writer.isShutdown()) writer.execute(this::deleteFile);
        }
    }

    /** Writes now, blocking. The unit test uses it; the save path does not need it. */
    public synchronized void flush() {
        persist();
    }

    /** Stops the writer thread, after letting its last write land. Tests and teardown only. */
    public void close() {
        // Not synchronized: the pending write needs this lock, and waiting for it while holding the
        // lock would just burn the timeout.
        writer.shutdown();
        try {
            // Bounded: a write that cannot finish must not hang the caller.
            writer.awaitTermination(2, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    // --- file ------------------------------------------------------------------------------------

    private void persist() {
        String frameText;
        long frameRev;
        long frameSavedAt;
        synchronized (this) {
            frameText = frame;
            frameRev = rev;
            frameSavedAt = savedAt;
        }
        if (frameText == null) return;
        try {
            File parent = file.getParentFile();
            if (parent != null && !parent.exists()) parent.mkdirs();
            File temp = new File(file.getAbsolutePath() + ".tmp");
            Files.write(temp.toPath(), encode(frameText, frameRev, frameSavedAt).getBytes(StandardCharsets.UTF_8));
            // Replace by rename, so a kill mid-write leaves the previous frame rather than half of one.
            if (!temp.renameTo(file)) {
                Files.write(file.toPath(), Files.readAllBytes(temp.toPath()));
                Files.deleteIfExists(temp.toPath());
            }
        } catch (IOException ignored) {
            // The link is best-effort; a cache that cannot be written must not break the app.
        }
    }

    private void deleteFile() {
        try {
            Files.deleteIfExists(file.toPath());
        } catch (IOException ignored) {
            // A leftover file only means the next boot serves an older frame.
        }
    }

    private synchronized void load() {
        try {
            if (!file.exists()) return;
            String[] parts = decode(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
            if (parts == null) return;
            frame = parts[0];
            rev = Long.parseLong(parts[1]);
            savedAt = Long.parseLong(parts[2]);
        } catch (IOException | RuntimeException ignored) {
            // A corrupt cache is an empty cache, never a crash on boot.
        }
    }

    /** Four lines: magic, rev, savedAt, frame. A frame never contains a raw newline (protocol §1). */
    static String encode(String frame, long rev, long savedAt) {
        return MAGIC + "\n" + rev + "\n" + savedAt + "\n" + frame + "\n";
    }

    /** {@code {frame, rev, savedAt}}, or null when the text is not one of our cache files. */
    static String[] decode(String text) {
        if (text == null) return null;
        String[] parts = text.split("\n", 4);
        if (parts.length < 4 || !MAGIC.equals(parts[0])) return null;
        long rev;
        long savedAt;
        try {
            rev = Long.parseLong(parts[1].trim());
            savedAt = Long.parseLong(parts[2].trim());
        } catch (NumberFormatException e) {
            return null;
        }
        // The frame is re-parsed before it is trusted: a half-written or edited file is an empty
        // cache, not a frame with a truncated JSON body.
        String frame = parts[3].trim();
        WearWire.Frame parsed = WearWire.parse(frame);
        if (parsed == null || !WearWire.TYPE_STATE.equals(parsed.type)) return null;
        if (rev < 0 || rev != parsed.rev) return null;
        return new String[] {frame, Long.toString(rev), Long.toString(savedAt)};
    }
}
