package ch.duartesantos.opengym;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.wear.remote.interactions.RemoteActivityHelper;
import com.google.common.util.concurrent.ListenableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * What the library itself accepts, measured rather than read (M8).
 *
 * <p>This cannot prove the launch reaches a real watch — that is M8.5, on Gus's devices. It proves
 * the half that is decidable off-hardware: the intent shape this project builds is the shape
 * {@link RemoteActivityHelper} requires, and the shape the first draft used is refused. The
 * `CATEGORY_BROWSABLE` requirement in {@code docs/notes/26-watch-autolaunch-findings.md} §2.2 is the
 * reason the second test exists.
 *
 * <p><b>Measured detail:</b> the reference page says a bad intent "will be rejected and a
 * IllegalArgumentException thrown", which reads as a synchronous throw. It is not: the call returns a
 * future and the rejection arrives on it. The first version of this test asserted a synchronous
 * throw and failed — recorded because it is exactly the kind of doc-vs-code gap this milestone is
 * about.
 */
@RunWith(AndroidJUnit4.class)
public class WearLaunchShapeTest {

    private static Context ctx() {
        return InstrumentationRegistry.getInstrumentation().getTargetContext();
    }

    @Test
    public void ourIntentIsViewBrowsableWear() {
        Intent intent = WearLaunch.intent();
        assertEquals(Intent.ACTION_VIEW, intent.getAction());
        assertNotNull(intent.getCategories());
        assertTrue(intent.getCategories().contains(Intent.CATEGORY_BROWSABLE));
        assertNotNull(intent.getData());
        assertEquals("wear", intent.getData().getScheme());
        assertEquals(WearLaunch.PATH, intent.getData().getPath());
    }

    /** The failure the future carried, or null when it resolved. */
    private static Throwable failureOf(ListenableFuture<Void> future) {
        try {
            future.get(10, TimeUnit.SECONDS);
            return null;
        } catch (ExecutionException e) {
            return e.getCause() == null ? e : e.getCause();
        } catch (Exception e) {
            return e;
        }
    }

    /** The documented rejection: no {@code CATEGORY_BROWSABLE} means the call is refused. */
    @Test
    public void missingBrowsableIsRejected() {
        Intent bad = new Intent(Intent.ACTION_VIEW).setData(Uri.parse("wear://*" + WearLaunch.PATH));
        RemoteActivityHelper helper = new RemoteActivityHelper(ctx(), Executors.newSingleThreadExecutor());
        Throwable failure = failureOf(helper.startRemoteActivity(bad, null));
        assertNotNull("the library accepted an intent with no CATEGORY_BROWSABLE", failure);
        assertTrue("expected IllegalArgumentException, got " + failure, failure instanceof IllegalArgumentException);
    }

    /**
     * The intent this project builds is not refused for its shape. On this emulator there is no
     * paired node, so the future itself may fail — with a remote-delivery error, not a shape error.
     */
    @Test
    public void ourIntentPassesTheLibraryValidation() {
        RemoteActivityHelper helper = new RemoteActivityHelper(ctx(), Executors.newSingleThreadExecutor());
        Throwable failure = failureOf(helper.startRemoteActivity(WearLaunch.intent(), null));
        assertFalse("our intent was refused for its shape: " + failure, failure instanceof IllegalArgumentException);
    }
}
