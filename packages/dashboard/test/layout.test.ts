/**
 * Layout-algorithm snapshot tests: mock topologies → ELK (the exact
 * options the canvas ships) → rendered SVG snapshots checked into
 * `test/__layouts__/`. The SVGs are viewable images, so any change to the
 * layout configuration shows up as a reviewable visual diff.
 *
 * Regenerate deliberately with:  UPDATE_LAYOUT_SNAPSHOTS=1 bun test
 *
 * Invariants asserted for every topology:
 * - deterministic: two runs produce identical positions
 * - no overlapping cards
 * - wide-screen bias where the topology allows it (aspect ≥ 1)
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  positionsOf,
  repackComponents,
  toElkGraph,
  type LayoutEdgeInput,
} from "../src/layout/elkGraph.ts";

// elkjs's node entry checks `typeof document === 'undefined' && self` to
// decide it is running inside a web worker — Bun defines `self`, so force
// the module.exports branch before requiring it.
(globalThis as { document?: unknown }).document ??= {};
const require = createRequire(import.meta.url);
// oxlint-disable-next-line no-require-imports
const ELK = require("elkjs/lib/elk-api.js") as new (options: {
  workerFactory: (url: string | undefined) => unknown;
}) => {
  layout: (graph: unknown) => Promise<{
    children?: { id: string; x?: number; y?: number }[];
  }>;
};
// oxlint-disable-next-line no-require-imports
const { Worker: ElkWorker } = require("elkjs/lib/elk-worker.js") as {
  Worker: new (url: string | undefined) => unknown;
};

/** A stable 16:10-laptop aspect target (window is unavailable in tests). */
const ASPECT = 1.9;

const layout = async (
  fqns: readonly string[],
  edges: readonly [string, string][],
): Promise<Map<string, { x: number; y: number }>> => {
  const elk = new ELK({ workerFactory: (url) => new ElkWorker(url) });
  const input: LayoutEdgeInput[] = edges.map(([source, target]) => ({
    source,
    target,
  }));
  const root = await elk.layout(toElkGraph(fqns, input, ASPECT));
  return new Map(
    repackComponents(positionsOf(root as never), input, ASPECT).map(
      ([fqn, x, y]) => [fqn, { x, y }],
    ),
  );
};

// ─────────────────────────────────────────────────────── mock topologies

interface Topology {
  name: string;
  nodes: string[];
  /** merged visual edges (the shape ELK actually receives) */
  edges: [string, string][];
  /** some shapes are inherently tall (a 1×N fan) — skip the aspect check */
  expectWide?: boolean;
}

const TOPOLOGIES: Topology[] = [
  {
    // replica of examples/cloudflare-worker (the canonical demo stack)
    name: "cloudflare-worker-example",
    nodes: [
      "Api",
      "SecondaryApi",
      "WorkerTag",
      "KV",
      "Bucket",
      "Queue",
      "Gateway",
      "Sandbox",
      "Notifier",
      "QueueConsumer",
      "AnnounceDeploy",
    ],
    edges: [
      ["KV", "Api"],
      ["Bucket", "Api"],
      ["Queue", "Api"],
      ["Gateway", "Api"],
      ["Api", "Notifier"],
      ["Api", "Sandbox"],
      ["SecondaryApi", "Sandbox"],
      ["Queue", "QueueConsumer"],
      ["Api", "QueueConsumer"],
      ["Bucket", "AnnounceDeploy"],
      ["Api", "AnnounceDeploy"],
    ],
    expectWide: true,
  },
  {
    name: "chain",
    nodes: ["A", "B", "C", "D", "E"],
    edges: [
      ["A", "B"],
      ["B", "C"],
      ["C", "D"],
      ["D", "E"],
    ],
    expectWide: true,
  },
  {
    name: "diamond",
    nodes: ["Source", "Left", "Right", "Sink"],
    edges: [
      ["Source", "Left"],
      ["Source", "Right"],
      ["Left", "Sink"],
      ["Right", "Sink"],
    ],
    expectWide: true,
  },
  {
    // one hub with heavy fan-in and fan-out — inherently tall-ish; the
    // assertion here is only overlap-freedom + determinism
    name: "hub-fan",
    nodes: [
      "Hub",
      ...Array.from({ length: 8 }, (_, i) => `In${i}`),
      ...Array.from({ length: 6 }, (_, i) => `Out${i}`),
    ],
    edges: [
      ...Array.from(
        { length: 8 },
        (_, i) => [`In${i}`, "Hub"] as [string, string],
      ),
      ...Array.from(
        { length: 6 },
        (_, i) => ["Hub", `Out${i}`] as [string, string],
      ),
    ],
  },
  {
    // disconnected components must pack toward the screen aspect instead
    // of stacking into a tall column
    name: "disconnected-components",
    nodes: ["A1", "A2", "B1", "B2", "C1", "C2", "Lone1", "Lone2"],
    edges: [
      ["A1", "A2"],
      ["B1", "B2"],
      ["C1", "C2"],
    ],
    expectWide: true,
  },
  {
    // two tiers with full crossings pressure
    name: "two-tier-crossing",
    nodes: [
      ...Array.from({ length: 5 }, (_, i) => `Src${i}`),
      "MidA",
      "MidB",
      ...Array.from({ length: 5 }, (_, i) => `Sink${i}`),
    ],
    edges: [
      ["Src0", "MidA"],
      ["Src1", "MidA"],
      ["Src2", "MidA"],
      ["Src2", "MidB"],
      ["Src3", "MidB"],
      ["Src4", "MidB"],
      ["MidA", "Sink0"],
      ["MidA", "Sink1"],
      ["MidB", "Sink1"],
      ["MidB", "Sink2"],
      ["MidA", "Sink3"],
      ["MidB", "Sink4"],
    ],
    expectWide: true,
  },
  {
    // a deeper pipeline with side taps — depth should map to WIDTH
    name: "deep-pipeline",
    nodes: [
      "Ingest",
      "Validate",
      "Transform",
      "Enrich",
      "Store",
      "Index",
      "Serve",
      "Metrics",
      "Alerts",
      "Archive",
    ],
    edges: [
      ["Ingest", "Validate"],
      ["Validate", "Transform"],
      ["Transform", "Enrich"],
      ["Enrich", "Store"],
      ["Store", "Index"],
      ["Index", "Serve"],
      ["Validate", "Metrics"],
      ["Store", "Metrics"],
      ["Metrics", "Alerts"],
      ["Store", "Archive"],
    ],
    expectWide: true,
  },
];

// ────────────────────────────────────────────────────────── SVG rendering

const bounds = (positions: ReadonlyMap<string, { x: number; y: number }>) => {
  const xs = [...positions.values()].map((p) => p.x);
  const ys = [...positions.values()].map((p) => p.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    width: Math.max(...xs) + NODE_WIDTH - Math.min(...xs),
    height: Math.max(...ys) + NODE_HEIGHT - Math.min(...ys),
  };
};

/** Deterministic, human-viewable rendering of a layout result. */
const toSvg = (
  topology: Topology,
  positions: ReadonlyMap<string, { x: number; y: number }>,
): string => {
  const box = bounds(positions);
  const pad = 24;
  const lines: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.round(box.width + pad * 2)} ${Math.round(box.height + pad * 2)}" font-family="monospace" font-size="13">`,
    `  <!-- ${topology.name}: ${Math.round(box.width)}x${Math.round(box.height)} aspect=${(box.width / box.height).toFixed(2)} -->`,
    `  <rect width="100%" height="100%" fill="#f4efe4"/>`,
  ];
  const at = (fqn: string) => {
    const p = positions.get(fqn)!;
    return { x: p.x - box.minX + pad, y: p.y - box.minY + pad };
  };
  for (const [source, target] of topology.edges) {
    const s = at(source);
    const t = at(target);
    lines.push(
      `  <line x1="${Math.round(s.x + NODE_WIDTH)}" y1="${Math.round(s.y + NODE_HEIGHT / 2)}" x2="${Math.round(t.x)}" y2="${Math.round(t.y + NODE_HEIGHT / 2)}" stroke="#8a7a5c" stroke-width="1.5"/>`,
    );
  }
  for (const fqn of topology.nodes) {
    const p = at(fqn);
    lines.push(
      `  <rect x="${Math.round(p.x)}" y="${Math.round(p.y)}" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="10" fill="#fdfaf1" stroke="#b19d76"/>`,
      `  <text x="${Math.round(p.x + 14)}" y="${Math.round(p.y + 28)}" fill="#3f3828">${fqn}</text>`,
    );
  }
  lines.push("</svg>", "");
  return lines.join("\n");
};

const SNAPSHOT_DIR = join(import.meta.dir, "__layouts__");

const matchSvgSnapshot = (name: string, svg: string): void => {
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const file = join(SNAPSHOT_DIR, `${name}.svg`);
  if (!existsSync(file) || process.env.UPDATE_LAYOUT_SNAPSHOTS === "1") {
    writeFileSync(file, svg);
    return;
  }
  expect(svg).toBe(readFileSync(file, "utf8"));
};

const overlaps = (
  positions: ReadonlyMap<string, { x: number; y: number }>,
): string[] => {
  const list = [...positions.entries()];
  const found: string[] = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (
        Math.abs(list[i][1].x - list[j][1].x) < NODE_WIDTH &&
        Math.abs(list[i][1].y - list[j][1].y) < NODE_HEIGHT
      ) {
        found.push(`${list[i][0]} <-> ${list[j][0]}`);
      }
    }
  }
  return found;
};

// ──────────────────────────────────────────────────────────────── tests

describe("canvas layout", () => {
  for (const topology of TOPOLOGIES) {
    test(topology.name, async () => {
      const positions = await layout(topology.nodes, topology.edges);
      expect(positions.size).toBe(topology.nodes.length);

      // deterministic: a second run is coordinate-identical
      const again = await layout(topology.nodes, topology.edges);
      expect([...again.entries()]).toEqual([...positions.entries()]);

      // no two cards overlap
      expect(overlaps(positions)).toEqual([]);

      // wide-screen bias where the topology allows it
      if (topology.expectWide) {
        const box = bounds(positions);
        expect(box.width / box.height).toBeGreaterThanOrEqual(1);
      }

      matchSvgSnapshot(topology.name, toSvg(topology, positions));
    });
  }
});
