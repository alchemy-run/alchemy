/**
 * Canvas layout orchestration.
 *
 * Everything here is keyed on the document's `structuralHash` — a digest of
 * the fqn set + edge-key set ONLY. Decorations, notes, statuses, filter
 * text, selection, and history overlays can never change the hash, so they
 * can never re-run ELK, move a node, or touch the viewport.
 *
 * - `mergeEdges` — O(E) visual-edge fold (Set-based reverse index).
 * - ELK runs in a Web Worker (`layoutWorker.ts`), requested exactly once
 *   per never-seen hash; results land in the store's `positionsByHash`
 *   LRU so they survive view switches and stage switches.
 * - While a new hash's layout is in flight, nodes are seeded from the last
 *   shown coordinates; brand-new nodes seed near their neighbors — nothing
 *   ever flashes at (0,0).
 */
import type { DocumentEdge } from "alchemy/Dashboard/Document";
import { useEffect, useMemo, useRef } from "react";
import {
  dashboardStore,
  getPositionMemory,
  getPositions,
  setPositions,
  useLayoutEpoch,
  usePositions,
  useStructuralHash,
  type XY,
} from "../store.ts";
import { NODE_HEIGHT, NODE_WIDTH } from "./elkGraph.ts";
import { requestLayout } from "./layoutWorker.ts";

export interface VisualEdge {
  source: string;
  target: string;
  binding: boolean;
}

/**
 * A binding edge host→resource usually coexists with the reverse dependency
 * edge resource→host (the host consumes the resource's outputs). Rendering
 * both draws a loop around the pair, so merge them: keep the dependency
 * direction, style it as a binding. O(E) via Set-based reverse indexes
 * (a per-binding-edge `edges.some(...)` scan would be O(E²)).
 */
export const mergeEdges = (edges: Iterable<DocumentEdge>): VisualEdge[] => {
  const all: DocumentEdge[] = [];
  const dependencyKeys = new Set<string>();
  const bindingKeys = new Set<string>();
  for (const edge of edges) {
    all.push(edge);
    const key = `${edge.source}->${edge.target}`;
    if (edge.kind === "dependency") {
      dependencyKeys.add(key);
    } else {
      bindingKeys.add(key);
    }
  }
  // pair key → visual edge; a dependency and a binding on the same pair
  // collapse to one binding-styled edge
  const merged = new Map<string, VisualEdge>();
  for (const edge of all) {
    const reverseKey = `${edge.target}->${edge.source}`;
    if (edge.kind === "binding" && dependencyKeys.has(reverseKey)) {
      continue; // folded into the reverse dependency edge
    }
    const binding = edge.kind === "binding" || bindingKeys.has(reverseKey);
    const pairKey = `${edge.source}->${edge.target}`;
    const existing = merged.get(pairKey);
    if (existing !== undefined) {
      existing.binding = existing.binding || binding;
    } else {
      merged.set(pairKey, {
        source: edge.source,
        target: edge.target,
        binding,
      });
    }
  }
  // deterministic order: stable ELK input + stable React Flow edge array
  return [...merged.values()].sort((a, b) =>
    a.source === b.source
      ? a.target.localeCompare(b.target)
      : a.source.localeCompare(b.source),
  );
};

/**
 * Interim coordinates while a hash's ELK layout is in flight: keep every
 * node the user is already looking at exactly where it is, place new nodes
 * near their neighbors (two passes so chains cascade), and grid anything
 * fully disconnected below the current bounding box.
 */
export const seedPositions = (
  fqns: readonly string[],
  edges: readonly VisualEdge[],
  known: ReadonlyMap<string, XY>,
): Map<string, XY> => {
  const out = new Map<string, XY>();
  const missing: string[] = [];
  for (const fqn of fqns) {
    const position = known.get(fqn);
    if (position !== undefined) {
      out.set(fqn, position);
    } else {
      missing.push(fqn);
    }
  }
  if (missing.length === 0) {
    return out;
  }

  const neighbors = new Map<string, string[]>();
  const addNeighbor = (from: string, to: string): void => {
    const list = neighbors.get(from);
    if (list === undefined) {
      neighbors.set(from, [to]);
    } else {
      list.push(to);
    }
  };
  for (const edge of edges) {
    addNeighbor(edge.source, edge.target);
    addNeighbor(edge.target, edge.source);
  }

  for (let pass = 0; pass < 2; pass++) {
    let stagger = 0;
    for (const fqn of missing) {
      if (out.has(fqn)) {
        continue;
      }
      const placed = (neighbors.get(fqn) ?? [])
        .map((neighbor) => out.get(neighbor))
        .filter((position): position is XY => position !== undefined);
      if (placed.length === 0) {
        continue;
      }
      let sumX = 0;
      let sumY = 0;
      for (const position of placed) {
        sumX += position.x;
        sumY += position.y;
      }
      out.set(fqn, {
        x: sumX / placed.length + 40 + stagger * 12,
        y: sumY / placed.length + NODE_HEIGHT + 28 + stagger * 10,
      });
      stagger += 1;
    }
  }

  // disconnected leftovers: grid below everything placed so far
  const leftovers = missing.filter((fqn) => !out.has(fqn));
  if (leftovers.length > 0) {
    let maxY = 0;
    for (const position of out.values()) {
      maxY = Math.max(maxY, position.y);
    }
    const perRow = 4;
    leftovers.forEach((fqn, index) => {
      out.set(fqn, {
        x: (index % perRow) * (NODE_WIDTH + 36),
        y:
          maxY +
          NODE_HEIGHT +
          60 +
          Math.floor(index / perRow) * (NODE_HEIGHT + 36),
      });
    });
  }
  return out;
};

/**
 * Two cards closer than a card's footprint = a broken arrangement (the
 * signature of a poisoned/legacy seed) — continuity must not preserve it.
 */
const hasOverlap = (positions: ReadonlyMap<string, XY>): boolean => {
  const list = [...positions.values()];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (
        Math.abs(list[i].x - list[j].x) < NODE_WIDTH - 8 &&
        Math.abs(list[i].y - list[j].y) < NODE_HEIGHT - 8
      ) {
        return true;
      }
    }
  }
  return false;
};

export interface CanvasLayout {
  /** the LIVE structural hash — node/edge arrays and position caches key on it */
  hash: string;
  /** sorted fqn set of the live structure */
  fqns: readonly string[];
  /** merged, deduped, sorted visual edges for `hash` */
  visualEdges: readonly VisualEdge[];
  /** ELK positions when cached for `hash`, else neighbor-seeded interim ones */
  positions: ReadonlyMap<string, XY>;
  /** true when `positions` came from a completed ELK layout for `hash` */
  layouted: boolean;
}

export const useCanvasLayout = (): CanvasLayout => {
  const hash = useStructuralHash();
  const layoutEpoch = useLayoutEpoch();

  // Structure content (fqn set + edge set incl. kinds) is fully covered by
  // the hash, so these derive-once memos key on the hash alone and read the
  // document imperatively — no other store change can invalidate them.
  const structure = useMemo(() => {
    const doc = dashboardStore.getState().document;
    return {
      fqns: [...doc.structure.nodes.keys()].sort() as readonly string[],
      visualEdges: mergeEdges(
        doc.structure.edges.values(),
      ) as readonly VisualEdge[],
    };
  }, [hash]);

  const cached = usePositions(hash);

  // Resolve positions whenever the structural hash (or layout epoch)
  // changes.
  //
  // Position CONTINUITY rules: when memory (fed by ELK results, drags,
  // seeds, and restored session layouts) covers the graph well, known
  // coordinates are kept VERBATIM and only the few genuine newcomers get
  // neighbor-seeded — a structural change cannot morph the topology the
  // user is watching. The seed is recomputed even for a hash seen earlier
  // this session, so returning to a previous shape honors drags made
  // since. When memory coverage is POOR (a fresh stage, or most of the
  // graph is new), neighbor-seeding would produce a tangled cascade — run
  // a full ELK layout instead. The explicit re-layout control clears all
  // position state and lands here too.
  useEffect(() => {
    if (structure.fqns.length === 0) {
      return;
    }
    const memory = getPositionMemory();
    const known = structure.fqns.filter((fqn) => memory.has(fqn)).length;
    const missing = structure.fqns.length - known;
    if (known > 0 && (missing === 0 || (missing <= 2 && known >= missing))) {
      const seeded = seedPositions(
        structure.fqns,
        structure.visualEdges,
        memory,
      );
      // continuity preserves ARRANGEMENTS, not accidents: a seed with
      // overlapping cards means the memory itself is broken (poisoned by
      // an old bug or a degenerate seed) — auto-heal with a fresh ELK
      // layout instead of faithfully reproducing the mess
      if (!hasOverlap(seeded)) {
        setPositions(hash, seeded);
        return;
      }
    }
    if (getPositions(hash) !== undefined) {
      return;
    }
    requestLayout(hash, structure.fqns, structure.visualEdges)
      .then((positions) => setPositions(hash, positions))
      .catch((error: unknown) => {
        console.error("[dashboard] elk layout failed", error);
      });
  }, [hash, structure, layoutEpoch]);

  // The coordinates currently on screen — the seed source when the next
  // hash appears before its layout lands.
  const lastShown = useRef<ReadonlyMap<string, XY>>(new Map());

  const positions = useMemo<ReadonlyMap<string, XY>>(
    () =>
      cached ??
      seedPositions(structure.fqns, structure.visualEdges, lastShown.current),
    [cached, structure],
  );

  useEffect(() => {
    lastShown.current = positions;
  }, [positions]);

  return useMemo<CanvasLayout>(
    () => ({
      hash,
      fqns: structure.fqns,
      visualEdges: structure.visualEdges,
      positions,
      layouted: cached !== undefined,
    }),
    [hash, structure, positions, cached],
  );
};
