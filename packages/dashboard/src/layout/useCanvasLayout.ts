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
 * (v1 ran `edges.some(...)` per binding edge — O(E²)).
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

  // Resolve positions exactly once per never-seen hash.
  //
  // Position CONTINUITY comes first: if any node of the new hash already
  // has a home this session (the per-node position memory — fed by ELK
  // results, drags, and previous seeds), those coordinates are kept
  // VERBATIM and only genuine newcomers get neighbor-seeded. ELK never
  // re-runs for a structural change mid-session, so plan overlays, run
  // convergence, and post-destroy rebuilds physically cannot morph the
  // topology the user is watching. ELK runs only when nothing has a
  // position yet (first layout of a stage).
  useEffect(() => {
    if (structure.fqns.length === 0 || getPositions(hash) !== undefined) {
      return;
    }
    const memory = getPositionMemory();
    if (structure.fqns.some((fqn) => memory.has(fqn))) {
      setPositions(
        hash,
        seedPositions(structure.fqns, structure.visualEdges, memory),
      );
      return;
    }
    requestLayout(hash, structure.fqns, structure.visualEdges)
      .then((positions) => setPositions(hash, positions))
      .catch((error: unknown) => {
        console.error("[dashboard] elk layout failed", error);
      });
  }, [hash, structure]);

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
