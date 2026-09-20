/**
 * Store simulation — run with `bun scripts/simulate-store.ts` from
 * packages/dashboard.
 *
 * Feeds a recorded snapshot + patch frames (shapes captured from the
 * phase-3 document/patch protocol) through applySnapshot / ingestPatches
 * and asserts:
 *  - selector outputs (node/decoration joins, timelines, op spans, feed)
 *  - referential stability of untouched slices across a patch batch
 *    (the per-fqn equality guard the render doctrine rests on)
 *  - sibling patches sharing one revision all apply; stale ones skip
 *  - a revision gap is flagged (the transport's re-snapshot trigger)
 *  - the history overlay swaps decorations without touching structure
 *  - projection memoization and the positionsByHash LRU cap
 */
import type {
  DocumentPatch,
  DocumentSnapshot,
} from "alchemy/Dashboard/Document";
import {
  applySnapshot,
  dashboardStore,
  getPositions,
  ingestPatches,
  isDimmed,
  resetForTarget,
  selectFeed,
  selectFilterCounts,
  selectMeta,
  selectNode,
  selectOpSpans,
  selectProjection,
  selectStructuralHash,
  selectTimeline,
  setFilter,
  setPositions,
  setSelectedDeployment,
  setSelectedFqn,
  type DeploymentRecord,
  type HistoricalProjections,
} from "../src/store.ts";

const assert = (condition: boolean, message: string): void => {
  if (!condition) {
    throw new Error(`ASSERT FAILED: ${message}`);
  }
};

// ───────────────────────────────────────────── fixture (phase-3 shapes)

const snapshot: DocumentSnapshot = {
  revision: 5,
  meta: { stack: "demo", stage: "dev", stages: ["dev", "prod"] },
  structure: {
    nodes: [
      {
        fqn: "bucket",
        logicalId: "bucket",
        path: [],
        kind: "resource",
        type: "AWS.S3.Bucket",
        status: "created",
        bindings: [],
        downstream: ["worker"],
      },
      {
        fqn: "worker",
        logicalId: "worker",
        path: [],
        kind: "resource",
        type: "Cloudflare.Worker",
        status: "pending",
        bindings: [{ sid: "AWS.S3.GetObject" }],
        downstream: [],
        planAction: "create",
      },
    ],
    edges: [{ kind: "dependency", source: "bucket", target: "worker" }],
    structuralHash: "hash-1",
  },
  decorations: {
    bucket: { status: "created", applyResult: "created", at: 1000 },
  },
  timelines: {
    bucket: [{ ts: 1000, level: "status", message: "created" }],
  },
  feed: [
    { key: 0, ts: 1000, id: "bucket", text: "created", status: "created" },
  ],
  deployment: {
    stack: "demo",
    stage: "dev",
    version: 7,
    meta: { command: "deploy", initiator: { user: "sam" } },
    startedAt: 900,
    heartbeatAt: 1000,
    live: true,
  },
  annotations: {},
  opSpans: {
    bucket: [
      {
        opId: "op-0",
        op: "create",
        startTs: 950,
        endTs: 1000,
        outcome: "ok",
        pendingTs: 910,
      },
    ],
  },
};

// one fold call = several patches sharing revision 6
const revision6: DocumentPatch[] = [
  {
    kind: "decorate",
    revision: 6,
    fqn: "worker",
    status: "creating",
    at: 2000,
  },
  {
    kind: "timeline-append",
    revision: 6,
    fqn: "worker",
    entries: [{ ts: 2000, level: "status", message: "creating" }],
    reset: true,
  },
  {
    kind: "feed-append",
    revision: 6,
    entries: [
      { key: 1, ts: 2000, id: "worker", text: "creating", status: "creating" },
    ],
  },
];

const revision7: DocumentPatch[] = [
  {
    kind: "op-span",
    revision: 7,
    fqn: "worker",
    span: { opId: "op-1", op: "create", startTs: 2100, pendingTs: 2000 },
  },
];

// stale duplicate (≤ snapshot baseline) — must be skipped
const stale: DocumentPatch = {
  kind: "decorate",
  revision: 5,
  fqn: "bucket",
  status: "creating",
  at: 500,
};

// revision 9 after 7 = gap — must flag, not apply
const gapPatch: DocumentPatch = {
  kind: "decorate",
  revision: 9,
  fqn: "worker",
  status: "created",
  at: 3000,
};

// ───────────────────────────────────────────────────── snapshot hydrate

applySnapshot(snapshot);
{
  const s = dashboardStore.getState();
  assert(s.hydrated, "hydrated after snapshot");
  assert(s.revision === 5, "revision mirrors snapshot");
  assert(selectStructuralHash(s) === "hash-1", "structural hash");
  assert(selectMeta(s).stack === "demo", "meta stack");
  assert(selectMeta(s).stages?.length === 2, "meta stages");
  const bucket = selectNode(s, "bucket");
  assert(bucket.node?.type === "AWS.S3.Bucket", "bucket node type");
  assert(bucket.decoration?.applyResult === "created", "bucket decoration");
  const worker = selectNode(s, "worker");
  assert(worker.node?.planAction === "create", "worker planAction baseline");
  assert(worker.decoration === undefined, "worker has no decoration yet");
  assert(selectFeed(s).entries.length === 1, "feed hydrated");
  assert(
    selectOpSpans(s, "bucket").spans[0]?.outcome === "ok",
    "bucket op span hydrated",
  );
}

// ────────────────────────────── sibling patches sharing one revision

{
  const before = dashboardStore.getState();
  const bucketBefore = selectNode(before, "bucket");
  const workerBefore = selectNode(before, "worker");

  const result = ingestPatches([...revision6, stale]);
  assert(
    result.applied === 3,
    `revision-6 siblings all apply (${result.applied})`,
  );
  assert(result.skipped === 1, "stale revision-5 patch skipped");
  assert(!result.gap, "no gap at revision 6");

  const s = dashboardStore.getState();
  assert(s.revision === 6, "revision advanced to 6");
  const worker = selectNode(s, "worker");
  assert(worker.decoration?.status === "creating", "worker decorated");
  // the render doctrine: untouched slices keep referential identity,
  // touched slices change — a decorate patch re-renders exactly its node
  assert(
    selectNode(s, "bucket") === bucketBefore,
    "bucket slice identity stable across the batch",
  );
  assert(worker !== workerBefore, "worker slice identity changed");
  assert(
    selectTimeline(s, "worker").entries.length === 1,
    "worker timeline appended",
  );
  assert(selectFeed(s).entries.length === 2, "feed appended");
  assert(selectFeed(s) === selectFeed(s), "feed slice memoized between reads");
}

// ───────────────────────────────────────────────────────────── op span

{
  const result = ingestPatches(revision7);
  assert(result.applied === 1 && !result.gap, "op-span applied");
  const s = dashboardStore.getState();
  const spans = selectOpSpans(s, "worker");
  assert(
    spans.spans.length === 1 && spans.spans[0]?.opId === "op-1",
    "worker span upserted",
  );
  const table = selectProjection(s, "table");
  const row = table.find((r) => r.fqn === "worker");
  assert(row?.status === "creating", "table row from live projection");
  assert(row?.waitMs === 100, "wait time from pendingTs→startTs");
  assert(
    selectProjection(s, "table") === table,
    "projection memoized on revision",
  );
}

// ─────────────────────────────────────────────── gap → re-snapshot flag

{
  const result = ingestPatches([gapPatch]);
  assert(result.gap, "revision gap flagged");
  assert(result.applied === 0, "gap patch not applied");
  const s = dashboardStore.getState();
  assert(s.revision === 7, "revision unchanged on gap");
  assert(
    selectNode(s, "worker").decoration?.status === "creating",
    "gap patch did not decorate",
  );

  // the transport re-snapshots; the stream then continues past the gap
  applySnapshot({
    ...snapshot,
    revision: 9,
    decorations: {
      ...snapshot.decorations,
      worker: { status: "created", applyResult: "created", at: 3000 },
    },
  });
  const after = dashboardStore.getState();
  assert(after.revision === 9, "re-snapshot advanced revision");
  assert(after.baselineRevision === 9, "baseline moved to re-snapshot");
  const resumed = ingestPatches([
    { kind: "outputs", revision: 10, value: { url: "https://demo" } },
  ]);
  assert(resumed.applied === 1, "stream resumes after re-snapshot");
}

// ─────────────────────────────────────────────── filter dims, never hides

{
  setFilter("bucket");
  const s = dashboardStore.getState();
  assert(!isDimmed(s, "bucket"), "matching node not dimmed");
  assert(isDimmed(s, "worker"), "non-matching node dimmed");
  assert(
    selectStructuralHash(s) === "hash-1",
    "filter never touches structure",
  );
  const counts = selectFilterCounts(s);
  assert(counts.shown === 1 && counts.total === 2, "filter counts");
  setFilter("");
}

// ─────────────────────────────────── history overlay: zero graph movement

{
  const record: DeploymentRecord = {
    stack: "demo",
    stage: "dev",
    version: 6,
    meta: { command: "deploy" },
    startedAt: 100,
    heartbeatAt: 400,
    endedAt: 400,
    outcome: "succeeded",
  };
  const historicalSnapshot: DocumentSnapshot = {
    ...snapshot,
    revision: 9,
    decorations: {
      bucket: { status: "created", applyResult: "updated", at: 300 },
    },
    timelines: {
      bucket: [{ ts: 300, level: "status", message: "updated" }],
    },
    feed: [{ key: 0, ts: 300, id: "bucket", text: "updated" }],
    opSpans: {},
  };
  const projections: HistoricalProjections = {
    summary: {
      counts: { byPlanAction: {}, byApplyResult: { updated: 1 } },
      annotations: [],
      failures: [],
    },
    tableRows: [{ fqn: "bucket", status: "created", applyResult: "updated" }],
    waterfallSpans: [],
    annotations: [],
  };
  const liveHash = selectStructuralHash(dashboardStore.getState());
  setSelectedDeployment(6, record, historicalSnapshot, projections);

  const s = dashboardStore.getState();
  // structure ALWAYS from the live document
  assert(selectStructuralHash(s) === liveHash, "overlay keeps live structure");
  assert(
    selectNode(s, "worker").node?.type === "Cloudflare.Worker",
    "overlay keeps live nodes",
  );
  // decorations/timelines/feed come from the overlay
  assert(
    selectNode(s, "bucket").decoration?.applyResult === "updated",
    "overlay decoration",
  );
  assert(
    selectNode(s, "worker").decoration === undefined,
    "overlay drops live-only decorations",
  );
  assert(selectFeed(s).entries.length === 1, "overlay feed");
  assert(
    selectOpSpans(s, "worker").spans.length === 0,
    "overlay op spans empty",
  );
  // server projections are used verbatim; list is computed client-side
  assert(
    selectProjection(s, "table") === projections.tableRows,
    "historical table = server projection",
  );
  assert(
    selectProjection(s, "summary") === projections.summary,
    "historical summary = server projection",
  );
  const list = selectProjection(s, "list");
  assert(
    list.some((g) => g.nodes.some((n) => n.fqn === "bucket")),
    "historical list computed from overlay snapshot",
  );
  assert(selectProjection(s, "list") === list, "historical list memoized");

  setSelectedDeployment("live");
  const live = dashboardStore.getState();
  assert(
    selectNode(live, "bucket").decoration?.applyResult === "created",
    "back to live decorations",
  );
}

// ─────────────────────────────────────────────────── positionsByHash LRU

{
  for (let i = 0; i < 55; i++) {
    setPositions(`hash-${i}`, new Map([["bucket", { x: i, y: 0 }]]));
  }
  const s = dashboardStore.getState();
  assert(s.layout.positionsByHash.size === 50, "LRU capped at 50");
  assert(getPositions("hash-54") !== undefined, "most recent hash kept");
  assert(getPositions("hash-0") === undefined, "oldest hash evicted");
  // positions survive a stage switch
  setSelectedFqn("bucket");
  resetForTarget({ stack: undefined, stage: "prod" });
  const switched = dashboardStore.getState();
  assert(!switched.hydrated, "stage switch drops the document");
  assert(
    switched.ui.selectedFqn === undefined,
    "stage switch clears selection",
  );
  assert(
    switched.layout.positionsByHash.size === 50,
    "positionsByHash survives stage switch",
  );
}

console.log("simulate-store OK");
