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

export const ELK_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.spacing.nodeNode": "44",
  "elk.layered.spacing.nodeNodeBetweenLayers": "90",
  "elk.layered.mergeEdges": "true",
  // disconnected subgraphs (e.g. the worker pair next to the command
  // pipeline) get real separation instead of packing into overlaps
  "elk.separateConnectedComponents": "true",
  "elk.spacing.componentComponent": "72",
};

export interface LayoutEdgeInput {
  source: string;
  target: string;
}

/** posted main thread → worker */
export interface LayoutRequestMessage {
  id: number;
  fqns: readonly string[];
  edges: readonly LayoutEdgeInput[];
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
): ElkNode => ({
  id: "root",
  layoutOptions: ELK_OPTIONS,
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
