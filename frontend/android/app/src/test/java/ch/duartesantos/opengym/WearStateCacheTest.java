package ch.duartesantos.opengym;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/**
 * The native cache lifecycle: publish → persist → a process restart → served. This is the property
 * decision 3 rests on — "what is the workout right now" must be answerable while the WebView is
 * frozen or not running — so it is checked against a real file on a real filesystem, not a mock.
 */
public class WearStateCacheTest {

    @Rule
    public TemporaryFolder dir = new TemporaryFolder();

    private static final String STATE_REV_17 =
            "{\"v\":1,\"type\":\"state\",\"rev\":17,\"sentAt\":1791665144842,\"workout\":{\"id\":\"mv2vv\",\"name\":\"Full Body A\"},"
                    + "\"rest\":{\"running\":true,\"endsAt\":1791665234842,\"total\":90,\"paused\":false,\"left\":null,\"restWhenIdle\":90}}";

    private static final String STATE_NO_WORKOUT =
            "{\"v\":1,\"type\":\"state\",\"rev\":1,\"sentAt\":5,\"workout\":null,"
                    + "\"rest\":{\"running\":false,\"endsAt\":null,\"total\":90,\"paused\":false,\"left\":null,\"restWhenIdle\":90}}";

    private File file() {
        return new File(dir.getRoot(), WearStateCache.FILE_NAME);
    }

    @Test
    public void aPublishedFrameSurvivesAProcessRestart() {
        WearStateCache first = new WearStateCache(file());
        first.save(STATE_REV_17, 17, 1791665144842L);
        first.flush();
        first.close();

        // "Restart": a new cache over the same file, exactly what a woken WearableListenerService
        // finds in a process that has just been unfrozen or recreated.
        WearStateCache second = new WearStateCache(file());
        assertTrue(second.hasFrame());
        assertEquals(STATE_REV_17, second.frame());
        assertEquals(17L, second.rev());
        assertEquals(1791665144842L, second.savedAt());
        second.close();
    }

    @Test
    public void theNewestFrameWins() {
        WearStateCache cache = new WearStateCache(file());
        cache.save(STATE_NO_WORKOUT, 1, 5);
        cache.save(STATE_REV_17, 17, 1791665144842L);
        cache.flush();
        cache.close();

        WearStateCache restarted = new WearStateCache(file());
        assertEquals(17L, restarted.rev());
        assertEquals(STATE_REV_17, restarted.frame());
        restarted.close();
    }

    @Test
    public void nothingIsServedBeforeAnythingIsPublished() {
        WearStateCache cache = new WearStateCache(file());
        assertFalse(cache.hasFrame());
        assertNull(cache.frame());
        assertEquals(-1L, cache.rev());
        cache.close();
    }

    @Test
    public void aWorkoutNullFrameIsCacheableItMeansNoSessionNotAnError() {
        WearStateCache cache = new WearStateCache(file());
        cache.save(STATE_NO_WORKOUT, 1, 5);
        cache.flush();
        cache.close();

        WearStateCache restarted = new WearStateCache(file());
        assertTrue(restarted.hasFrame());
        assertTrue(restarted.frame().contains("\"workout\":null"));
        assertEquals(1L, restarted.rev());
        restarted.close();
    }

    @Test
    public void onlyFramesThatAreStateFramesAreCached() {
        WearStateCache cache = new WearStateCache(file());
        cache.save(WearWire.encodeHello(WearWire.ROLE_PHONE, 1, new int[] {1}), 0, 1);
        cache.save(WearWire.encodeAck("c-1-1", WearWire.ACK_APPLIED, null, 3, 4), 3, 4);
        cache.save("not json", 0, 0);
        cache.save(null, 0, 0);
        assertFalse(cache.hasFrame());
        cache.close();
    }

    @Test
    public void clearingLeavesNothingForTheNextHelloToServe() {
        WearStateCache cache = new WearStateCache(file());
        cache.save(STATE_REV_17, 17, 1791665144842L);
        cache.flush();
        cache.clear();
        cache.flush();
        cache.close();

        assertFalse(file().exists());
        WearStateCache restarted = new WearStateCache(file());
        assertFalse(restarted.hasFrame());
        restarted.close();
    }

    @Test
    public void writeIsAtomicSoNoTemporaryFileIsLeftBehind() {
        WearStateCache cache = new WearStateCache(file());
        cache.save(STATE_REV_17, 17, 1791665144842L);
        cache.flush();
        cache.close();
        String[] names = dir.getRoot().list();
        assertEquals(1, names.length);
        assertEquals(WearStateCache.FILE_NAME, names[0]);
    }

    @Test
    public void aCorruptOrTruncatedCacheIsAnEmptyCacheNotACrash() throws Exception {
        File target = file();
        Files.write(target.toPath(), "opengym-wear-state/1\n17\n1791665144842\n{\"v\":1,\"type\":\"state\",\"rev\":17,\"sent".getBytes(StandardCharsets.UTF_8));
        WearStateCache cache = new WearStateCache(target);
        assertFalse(cache.hasFrame());
        cache.close();

        Files.write(target.toPath(), WearStateCache.encode(STATE_REV_17, 18, 1).getBytes(StandardCharsets.UTF_8));
        WearStateCache mismatched = new WearStateCache(target);
        assertFalse("a header rev that disagrees with the frame is not trusted", mismatched.hasFrame());
        mismatched.close();

        Files.write(target.toPath(), "some other app's file\n".getBytes(StandardCharsets.UTF_8));
        WearStateCache foreign = new WearStateCache(target);
        assertFalse(foreign.hasFrame());
        foreign.close();
    }

    @Test
    public void theCacheFileIsNotOpenGyms() {
        // Named and located by us, inside the app's private dir. `opengym-state.json` is openGym's
        // document, rewritten on every tap by its own code; this must never be that file.
        assertFalse(WearStateCache.FILE_NAME.contains("opengym-state"));
    }
}
