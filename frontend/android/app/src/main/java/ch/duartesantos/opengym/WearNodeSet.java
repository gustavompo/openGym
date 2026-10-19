package ch.duartesantos.opengym;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * The nodes the phone currently has a Data Layer connection to.
 *
 * <p>The Data Layer addresses nodes, not host:port (decision 2), so this is a set of node ids that
 * come and go, and node connect/disconnect is an ordinary event rather than an error. Order is
 * insertion order, so a broadcast to "all nodes" is deterministic for a log or a test.
 *
 * <p>Pure {@code java.util}, therefore unit-tested on the JVM ({@code WearNodeSetTest}).
 */
public final class WearNodeSet {

    private final Set<String> ids = new LinkedHashSet<>();

    /** @return true when this id was not already known (i.e. this is a (re)appearance). */
    public synchronized boolean add(String nodeId) {
        if (nodeId == null || nodeId.isEmpty()) return false;
        return ids.add(nodeId);
    }

    /** @return true when the id was known and is now gone. */
    public synchronized boolean remove(String nodeId) {
        return ids.remove(nodeId);
    }

    public synchronized boolean contains(String nodeId) {
        return ids.contains(nodeId);
    }

    public synchronized List<String> ids() {
        return new ArrayList<>(ids);
    }

    public synchronized int size() {
        return ids.size();
    }

    public synchronized boolean isEmpty() {
        return ids.isEmpty();
    }

    /** Replaces the whole set from a fresh node enumeration, keeping insertion order. */
    public synchronized void replace(List<String> current) {
        ids.clear();
        if (current != null) {
            for (String id : current) add(id);
        }
    }
}
