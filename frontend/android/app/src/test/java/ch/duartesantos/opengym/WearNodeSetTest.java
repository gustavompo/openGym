package ch.duartesantos.opengym;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import org.junit.Test;

/**
 * Node tracking (decision 2: the Data Layer addresses nodes, not addresses, and a node appearing or
 * disappearing is an ordinary event). The phone broadcasts to whatever set it has; the watch picks
 * one phone deterministically on its own side.
 */
public class WearNodeSetTest {

    @Test
    public void aNodeAppearingIsReportedOnceAndIsThenRemembered() {
        WearNodeSet nodes = new WearNodeSet();
        assertTrue(nodes.isEmpty());
        assertTrue("the first sighting is the event", nodes.add("watch-1"));
        assertFalse("a repeat is not a new appearance", nodes.add("watch-1"));
        assertEquals(1, nodes.size());
        assertTrue(nodes.contains("watch-1"));
    }

    @Test
    public void aNodeDisconnectIsJustARemoval() {
        WearNodeSet nodes = new WearNodeSet();
        nodes.add("watch-1");
        assertTrue(nodes.remove("watch-1"));
        assertFalse(nodes.remove("watch-1"));
        assertTrue(nodes.isEmpty());
        assertFalse(nodes.contains("watch-1"));
    }

    @Test
    public void aReconnectingNodeAppearsAgain() {
        WearNodeSet nodes = new WearNodeSet();
        nodes.add("watch-1");
        nodes.remove("watch-1");
        assertTrue(nodes.add("watch-1"));
        assertEquals(Arrays.asList("watch-1"), nodes.ids());
    }

    @Test
    public void theOrderIsInsertionOrderSoABroadcastIsDeterministic() {
        WearNodeSet nodes = new WearNodeSet();
        nodes.add("watch-b");
        nodes.add("watch-a");
        nodes.add("watch-c");
        assertEquals(Arrays.asList("watch-b", "watch-a", "watch-c"), nodes.ids());
    }

    @Test
    public void anEmptyOrNullNodeIdIsNotANode() {
        WearNodeSet nodes = new WearNodeSet();
        assertFalse(nodes.add(null));
        assertFalse(nodes.add(""));
        assertTrue(nodes.isEmpty());
    }

    @Test
    public void replaceTakesAFreshEnumeration() {
        WearNodeSet nodes = new WearNodeSet();
        nodes.add("stale-1");
        nodes.add("stale-2");
        nodes.replace(Arrays.asList("watch-1", "watch-2"));
        assertEquals(Arrays.asList("watch-1", "watch-2"), nodes.ids());
        nodes.replace(null);
        assertTrue(nodes.isEmpty());
    }
}
