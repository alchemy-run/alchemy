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
