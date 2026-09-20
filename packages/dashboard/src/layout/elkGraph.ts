/**
 * Shared ELK graph scaffolding — imported by BOTH the main thread
 * (`layoutWorker.ts`) and the Web Worker entry (`elk.worker.ts`). Keep this
 * module dependency-free (no React, no store) so the worker bundle stays
 * lean.
 */
import type { ElkNode } from "elkjs/lib/elk.bundled.js";

/**
 * Fixed node card dimensions — ELK needs no measurement pass. Height is
 * sized for the TALLEST card variant (Worker: title + type + URL + chip
 * rows ≈ 120px); shorter cards just get more breathing room, while
 * underestimating makes rows overlap.
 */
export const NODE_WIDTH = 230;
export const NODE_HEIGHT = 120;

/**
 * Layout algorithm, surveyed for "infrastructure topology on a wide
 * screen":
 *
 * - Force-directed / stress models have no concept of flow direction — a
 *   dependency DAG renders as an undirected blob. Rejected.
 * - Orthogonal routers (circuit-style) optimize bend counts for edge
 *   paths we don't even use (React Flow draws its own beziers). Rejected.
 * - The Sugiyama layered framework (layer assignment → crossing
 *   minimization → coordinate assignment) is THE standard for dependency
 *   DAGs, and ELK `layered` is its most complete implementation (dagre /
 *   d3-dag are simpler cousins). Kept — the quality comes from turning
 *   the knobs the defaults leave off:
 *
 * - direction RIGHT: dependency depth maps to X, so chains grow
 *   horizontally — the natural fit for a screen wider than tall.
 * - layering + nodePlacement NETWORK_SIMPLEX: both phases minimize total
 *   (weighted) edge length instead of the faster defaults — hubs sit
 *   centered on their fan-in/fan-out, edges come out straighter, layers
 *   stay balanced. Our graphs are tiny (10–100 nodes); the extra
 *   milliseconds are irrelevant.
 * - favorStraightEdges: bias placement toward horizontal edges over
 *   perfectly-aligned node columns.
 * - thoroughness 30 (default 7): more crossing-minimization sweeps.
 * - considerModelOrder NODES_AND_EDGES: ties break by input order (we
 *   pass sorted fqns) — layouts are deterministic run over run.
 * - separateConnectedComponents + aspectRatio: disconnected pieces
 *   (standalone workers, action nodes) pack toward the viewer's screen
 *   shape instead of stacking into a tall column.
 * - spacing: tighter within a layer (vertical), roomier between layers
 *   (horizontal) — pushes the drawing wide, not tall, and gives the
 *   bezier edges room to read.
 */
export const ELK_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.layered.layering.strategy": "NETWORK_SIMPLEX",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.layered.nodePlacement.favorStraightEdges": "true",
  "elk.layered.thoroughness": "30",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.layered.mergeEdges": "true",
  "elk.spacing.nodeNode": "36",
  "elk.layered.spacing.nodeNodeBetweenLayers": "120",
  // disconnected subgraphs (e.g. the worker pair next to the command
  // pipeline) get real separation instead of packing into overlaps
  "elk.separateConnectedComponents": "true",
  "elk.spacing.componentComponent": "64",
};

/** Component packing targets the viewer's screen shape, within reason. */
export const clampAspectRatio = (ratio: number): number =>
  Math.min(2.4, Math.max(1.4, ratio));

export interface LayoutEdgeInput {
  source: string;
  target: string;
}

/** posted main thread → worker */
export interface LayoutRequestMessage {
  id: number;
  fqns: readonly string[];
  edges: readonly LayoutEdgeInput[];
  /** viewport width/height — biases disconnected-component packing */
  aspectRatio: number;
}

/** posted worker → main thread */
export interface LayoutResponseMessage {
  id: number;
  ok: boolean;
  /** [fqn, x, y] triples (Maps don't structured-clone ergonomically) */
  positions?: [string, number, number][];
  error?: string;
}

export const toElkGraph = (
  fqns: readonly string[],
  edges: readonly LayoutEdgeInput[],
  aspectRatio: number,
): ElkNode => ({
  id: "root",
  layoutOptions: {
    ...ELK_OPTIONS,
    "elk.aspectRatio": String(clampAspectRatio(aspectRatio)),
  },
  children: fqns.map((fqn) => ({
    id: fqn,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  })),
  edges: edges.map((edge, index) => ({
    id: `e${index}`,
    sources: [edge.source],
    targets: [edge.target],
  })),
});

export const positionsOf = (root: ElkNode): [string, number, number][] =>
  (root.children ?? []).map((child) => [child.id, child.x ?? 0, child.y ?? 0]);

const COMPONENT_GAP = 64;

/**
 * Re-pack disconnected components toward the target aspect ratio.
 *
 * ELK's own component placement sizes its packing area from
 * `sqrt(totalArea × aspectRatio)` — for the small graphs a stack
 * typically has, that width fits at most one component per row and the
 * result stacks into a column regardless of the aspect hint. This pass
 * keeps ELK's per-component layouts verbatim and shelf-packs their
 * bounding boxes left-to-right (tallest shelf first, wrapping at the
 * aspect-derived width, never narrower than the widest component).
 * Deterministic: components sort by height, then their smallest fqn.
 */
export const repackComponents = (
  positions: [string, number, number][],
  edges: readonly LayoutEdgeInput[],
  aspectRatio: number,
): [string, number, number][] => {
  // union-find over fqns
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let root = a;
    while ((parent.get(root) ?? root) !== root) {
      root = parent.get(root) ?? root;
    }
    parent.set(a, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent.set(ra, rb);
    }
  };
  for (const [fqn] of positions) {
    parent.set(fqn, parent.get(fqn) ?? fqn);
  }
  for (const edge of edges) {
    union(edge.source, edge.target);
  }

  interface Component {
    key: string;
    fqns: [string, number, number][];
    minX: number;
    minY: number;
    width: number;
    height: number;
  }
  const byRoot = new Map<string, [string, number, number][]>();
  for (const entry of positions) {
    const root = find(entry[0]);
    const list = byRoot.get(root);
    if (list === undefined) {
      byRoot.set(root, [entry]);
    } else {
      list.push(entry);
    }
  }
  if (byRoot.size <= 1) {
    return positions;
  }
  const components: Component[] = [...byRoot.values()].map((fqns) => {
    const xs = fqns.map(([, x]) => x);
    const ys = fqns.map(([, , y]) => y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return {
      key: [...fqns].map(([fqn]) => fqn).sort()[0] ?? "",
      fqns,
      minX,
      minY,
      width: Math.max(...xs) + NODE_WIDTH - minX,
      height: Math.max(...ys) + NODE_HEIGHT - minY,
    };
  });
  components.sort((a, b) =>
    a.height === b.height ? a.key.localeCompare(b.key) : b.height - a.height,
  );

  const pack = (
    targetWidth: number,
  ): { out: [string, number, number][]; width: number; height: number } => {
    const out: [string, number, number][] = [];
    let shelfX = 0;
    let shelfY = 0;
    let shelfHeight = 0;
    let width = 0;
    for (const component of components) {
      if (shelfX > 0 && shelfX + component.width > targetWidth) {
        shelfX = 0;
        shelfY += shelfHeight + COMPONENT_GAP;
        shelfHeight = 0;
      }
      for (const [fqn, x, y] of component.fqns) {
        out.push([
          fqn,
          x - component.minX + shelfX,
          y - component.minY + shelfY,
        ]);
      }
      width = Math.max(width, shelfX + component.width);
      shelfX += component.width + COMPONENT_GAP;
      shelfHeight = Math.max(shelfHeight, component.height);
    }
    return { out, width, height: shelfY + shelfHeight };
  };

  // Try a spread of shelf widths and keep the packing whose aspect lands
  // closest to the target — a single sqrt-area guess is routinely a hair
  // too narrow, wrapping a small trailing component onto its own shelf.
  const target = clampAspectRatio(aspectRatio);
  const totalArea = components.reduce(
    (sum, c) => sum + (c.width + COMPONENT_GAP) * (c.height + COMPONENT_GAP),
    0,
  );
  const base = Math.max(
    ...components.map((c) => c.width),
    Math.sqrt(totalArea * target),
  );
  let best:
    | { out: [string, number, number][]; score: number; area: number }
    | undefined;
  for (const factor of [1, 1.25, 1.5, 1.75, 2, 2.5]) {
    const candidate = pack(base * factor);
    const aspect = candidate.width / Math.max(1, candidate.height);
    const score = Math.abs(Math.log(aspect / target));
    const area = candidate.width * candidate.height;
    if (
      best === undefined ||
      score < best.score - 1e-9 ||
      (Math.abs(score - best.score) <= 1e-9 && area < best.area)
    ) {
      best = { out: candidate.out, score, area };
    }
  }
  return best?.out ?? positions;
};
