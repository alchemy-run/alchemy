/**
 * Dashboard document core: the pure fold (events → document), minimal
 * patch derivation, snapshot round-trips, and the view projections.
 *
 * The load-bearing property: applying the emitted patch stream to a
 * snapshot clone reproduces the mutated document exactly — the whole
 * transport protocol rests on it.
 */
import {
  applyDeploymentRecord,
  applyEvent,
  applyPlan,
  applyStructure,
  clearApproval,
  foldJournal,
  fromSnapshot,
  makeDocument,
  setApproval,
  setMeta,
  setOutputs,
  snapshotOf,
  TIMELINE_CAP,
  type DeploymentDocument,
  type DocumentPatch,
} from "@/Dashboard/Document.ts";
import { applyStates } from "@/Dashboard/DocumentStates.ts";
import { applyPatches } from "@/Dashboard/DocumentPatch.ts";
import type { DashboardEvent } from "@/Dashboard/Event.ts";
import type { DashboardPlan } from "@/Dashboard/PlanJson.ts";
import {
  annotationsOf,
  listGroupsOf,
  summaryOf,
  tableRowsOf,
  waterfallSpansOf,
} from "@/Dashboard/Projections.ts";
import { State } from "@/State";
import type { PersistedState } from "@/State/State.ts";
import type { ResourceState } from "@/State/ResourceState.ts";
import * as Test from "@/Test/Alchemy";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import { TestLayers, TestResource } from "../test.resources.ts";
import {
  makeHistory,
  statusChange,
  successfulDeployJournal,
} from "./fixtures/history.ts";

const { test } = Test.make({ providers: TestLayers() });

// ── fixtures ───────────────────────────────────────────────────────────────

const createdState = (
  fqn: string,
  options?: { downstream?: string[] },
): ResourceState => ({
  kind: "resource",
  resourceType: "Test.Bucket",
  namespace: undefined,
  fqn,
  logicalId: fqn.split("/").at(-1)!,
  instanceId: `i-${fqn}`,
  providerVersion: 1,
  status: "created",
  downstream: options?.downstream ?? [],
  bindings: [],
  props: {},
  attr: {},
});

const emptyPlan: DashboardPlan = {
  available: true,
  resources: {},
  deletions: {},
  actions: {},
  cycleMembers: [],
};

const makeDoc = () => makeDocument({ stack: "docstack", stage: "test" });

/** Assert every patch of one mutation shares the doc's (bumped) revision. */
const expectRevisioned = (
  doc: DeploymentDocument,
  patches: DocumentPatch[],
) => {
  for (const patch of patches) {
    expect(patch.revision).toBe(doc.revision);
  }
};

// ── deployed stack + journal hydration ─────────────────────────────────────

describe("document fold — deploy journal", () => {
  test.provider(
    "folds a deploy journal over a deployed stack's states",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.deploy(
          Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a" });
            const B = yield* TestResource("B", { string: A.string });
            return { A, B };
          }),
        );

        // the persisted baseline, read exactly like the host does
        const store = yield* yield* State;
        const fqns = yield* store.list({ stack: stack.name, stage: "test" });
        const states = yield* Effect.forEach(fqns, (fqn) =>
          store.get({ stack: stack.name, stage: "test", fqn }),
        );

        // the journal a journaling engine would have written for that deploy
        const fixture = makeHistory();
        const record = fixture.put({
          stack: stack.name,
          stage: "test",
          version: 1,
          meta: { command: "deploy", initiator: { user: "test" } },
          startedAt: 1_000,
          heartbeatAt: 2_100,
          endedAt: 2_100,
          outcome: "succeeded",
        });
        fixture.journal(1, successfulDeployJournal(["A", "B"]));
        const events = yield* fixture.history.readEvents({
          stack: stack.name,
          stage: "test",
          version: 1,
        });
        expect(events.length).toBeGreaterThan(0);

        // hydrate exactly like the server: baseline states, deployment
        // record, then the journal replay
        const doc = makeDoc();
        const revisions: number[] = [0];
        const all: DocumentPatch[] = [];
        const track = ({ patches }: { patches: DocumentPatch[] }) => {
          revisions.push(doc.revision);
          all.push(...patches);
        };
        // clone BEFORE mutating for the patch-equivalence check below
        const clone = fromSnapshot(snapshotOf(doc));

        track(
          applyStates(
            doc,
            states.filter((s): s is PersistedState => s !== undefined),
          ),
        );
        track(applyDeploymentRecord(doc, record));
        track(foldJournal(doc, events));

        // revision is monotonic and every patch carries a valid revision
        for (let i = 1; i < revisions.length; i++) {
          expect(revisions[i]).toBeGreaterThanOrEqual(revisions[i - 1]);
        }
        let last = 0;
        for (const patch of all) {
          expect(patch.revision).toBeGreaterThanOrEqual(last);
          last = patch.revision;
        }
        expect(doc.revision).toBe(last);

        // both resources decorated created
        for (const fqn of ["A", "B"]) {
          const decoration = doc.decorations.get(fqn);
          expect(decoration?.status).toBe("created");
          expect(decoration?.applyResult).toBe("created");
          expect(doc.structure.nodes.get(fqn)).toBeDefined();
        }
        // B depends on A's output: the dependency edge came from state
        expect(doc.structure.edges.has("dependency:A->B")).toBe(true);

        // op spans are complete: start <= end, outcome ok
        const spansA = doc.opSpans.get("A") ?? [];
        const spansB = doc.opSpans.get("B") ?? [];
        expect(spansA).toHaveLength(1);
        expect(spansB).toHaveLength(1);
        for (const span of [...spansA, ...spansB]) {
          expect(span.endTs).toBeDefined();
          expect(span.endTs!).toBeGreaterThanOrEqual(span.startTs);
          expect(span.outcome).toBe("ok");
        }

        // deployment closed
        expect(doc.deployment?.live).toBe(false);
        expect(doc.deployment?.outcome).toBe("succeeded");
        expect(doc.deployment?.version).toBe(1);

        // projections
        const summary = summaryOf(doc);
        expect(summary.counts.byApplyResult.created).toBe(2);
        expect(summary.failures).toEqual([]);
        expect(summary.deployment?.command).toBe("deploy");
        expect(summary.deployment?.live).toBe(false);

        const rows = tableRowsOf(doc);
        const rowA = rows.find((r) => r.fqn === "A");
        const rowB = rows.find((r) => r.fqn === "B");
        expect(rowA?.runMs).toBeGreaterThanOrEqual(0);
        expect(rowB?.runMs).toBeGreaterThanOrEqual(0);
        expect(rowA?.status).toBe("created");

        const waterfall = waterfallSpansOf(doc);
        expect(waterfall.length).toBe(2);
        for (let i = 1; i < waterfall.length; i++) {
          expect(waterfall[i].segments[0].startTs).toBeGreaterThanOrEqual(
            waterfall[i - 1].segments[0].startTs,
          );
        }

        const groups = listGroupsOf(doc);
        const completed = groups.find((g) => g.group === "completed");
        expect(completed?.nodes.map((n) => n.fqn)).toEqual(["A", "B"]);

        // the patch stream reproduces the document
        applyPatches(clone, all);
        expect(snapshotOf(clone)).toEqual(snapshotOf(doc));
      }),
  );
});

// ── plan / structure overlay ───────────────────────────────────────────────

describe("document fold — structure passes", () => {
  it.effect("plan overlay adds nodes and deletion ghosts, never removes", () =>
    Effect.sync(() => {
      const doc = makeDoc();
      const first = applyStates(doc, new Map([["a", createdState("a")]]));
      expect(first.patches.map((p) => p.kind)).toEqual(["structure-replace"]);
      const hash1 = doc.structure.structuralHash;

      const plan: DashboardPlan = {
        available: true,
        resources: {
          a: {
            fqn: "a",
            logicalId: "a",
            type: "Test.Bucket",
            action: "update",
            downstream: [],
            bindings: [],
          },
          c: {
            fqn: "c",
            logicalId: "c",
            type: "Test.Bucket",
            action: "create",
            downstream: ["a"],
            bindings: [],
          },
        },
        deletions: {
          d: {
            fqn: "d",
            logicalId: "d",
            type: "Test.Bucket",
            action: "delete",
            downstream: [],
            bindings: [],
          },
          o: {
            fqn: "o",
            logicalId: "o",
            type: "Test.Bucket",
            action: "orphaned",
            downstream: [],
            bindings: [],
          },
        },
        actions: {},
        cycleMembers: [],
      };
      const second = applyPlan(doc, plan);
      expect(second.patches.map((p) => p.kind)).toEqual(["structure-replace"]);
      expect(doc.structure.nodes.size).toBe(4);
      expect(doc.structure.nodes.get("a")?.planAction).toBe("update");
      expect(doc.structure.nodes.get("c")?.status).toBe("pending");
      expect(doc.structure.nodes.get("c")?.planAction).toBe("create");
      expect(doc.structure.nodes.get("d")?.ghost).toBe("deleted");
      expect(doc.structure.nodes.get("d")?.status).toBe("created");
      // an orphan leaves the stack the same way a deletion does — it
      // exists in the cloud today and is gone from the graph tomorrow
      expect(doc.structure.nodes.get("o")?.ghost).toBe("deleted");
      expect(doc.structure.nodes.get("o")?.planAction).toBe("orphaned");
      expect(doc.structure.edges.has("dependency:c->a")).toBe(true);
      const hash2 = doc.structure.structuralHash;
      expect(hash2).not.toBe(hash1);

      // re-applying the identical plan is a no-op: no patches, no revision
      const revision = doc.revision;
      const third = applyPlan(doc, plan);
      expect(third.patches).toEqual([]);
      expect(doc.revision).toBe(revision);
      expect(doc.structure.structuralHash).toBe(hash2);
    }),
  );

  it.effect(
    "planAction change without a set change keeps the structuralHash",
    () =>
      Effect.sync(() => {
        const doc = makeDoc();
        applyStates(doc, new Map([["a", createdState("a")]]));
        const hash = doc.structure.structuralHash;
        const plan: DashboardPlan = {
          ...emptyPlan,
          resources: {
            a: {
              fqn: "a",
              logicalId: "a",
              type: "Test.Bucket",
              action: "adopted",
              downstream: [],
              bindings: [],
            },
          },
        };
        const { patches } = applyPlan(doc, plan);
        // content changed (planAction) → structure-replace, but the SET
        // didn't change → same hash, so renderers don't relayout
        expect(patches.map((p) => p.kind)).toEqual(["structure-replace"]);
        expect(doc.structure.structuralHash).toBe(hash);
        expect(doc.structure.nodes.get("a")?.planAction).toBe("adopted");
      }),
  );

  it.effect("structure pass adds ghosts + binding edges additively", () =>
    Effect.sync(() => {
      const doc = makeDoc();
      applyStates(doc, new Map([["a", createdState("a")]]));
      const { patches } = applyStructure(doc, {
        resources: [
          { fqn: "a", logicalId: "a", type: "Test.Bucket", bindingSids: [] },
          {
            fqn: "w",
            logicalId: "w",
            type: "Test.Function",
            bindingSids: ["a"],
          },
        ],
      });
      expect(patches.map((p) => p.kind)).toEqual(["structure-replace"]);
      expect(doc.structure.nodes.get("w")?.ghost).toBe("structure");
      expect(doc.structure.nodes.get("a")?.ghost).toBeUndefined();
      expect(doc.structure.edges.has("binding:w->a")).toBe(true);

      // idempotent
      const revision = doc.revision;
      const again = applyStructure(doc, {
        resources: [
          { fqn: "a", logicalId: "a", type: "Test.Bucket", bindingSids: [] },
          {
            fqn: "w",
            logicalId: "w",
            type: "Test.Function",
            bindingSids: ["a"],
          },
        ],
      });
      expect(again.patches).toEqual([]);
      expect(doc.revision).toBe(revision);
    }),
  );

  it.effect("applyStates rebuild retires plan/structure ghosts", () =>
    Effect.sync(() => {
      const doc = makeDoc();
      applyStates(doc, new Map([["a", createdState("a")]]));
      applyPlan(doc, {
        ...emptyPlan,
        resources: {
          c: {
            fqn: "c",
            logicalId: "c",
            type: "Test.Bucket",
            action: "create",
            downstream: [],
            bindings: [],
          },
        },
      });
      expect(doc.structure.nodes.size).toBe(2);
      applyStates(doc, new Map([["a", createdState("a")]]));
      expect([...doc.structure.nodes.keys()]).toEqual(["a"]);
    }),
  );
});

// ── event fold ─────────────────────────────────────────────────────────────

describe("document fold — events", () => {
  it.effect("status-change emits decorate + timeline(reset) + feed", () =>
    Effect.sync(() => {
      const doc = makeDoc();
      applyStates(doc, new Map([["a", createdState("a")]]));
      const hash = doc.structure.structuralHash;

      const { patches } = applyEvent(doc, statusChange("a", "creating", 10));
      expect(patches.map((p) => p.kind)).toEqual([
        "decorate",
        "timeline-append",
        "feed-append",
      ]);
      expectRevisioned(doc, patches);
      // decoration patches never touch structure
      expect(doc.structure.structuralHash).toBe(hash);
      expect(doc.decorations.get("a")).toEqual({
        status: "creating",
        at: 10,
      });
      const timeline = patches[1] as Extract<
        DocumentPatch,
        { kind: "timeline-append" }
      >;
      expect(timeline.reset).toBe(true);
      expect(timeline.entries).toEqual([
        { ts: 10, level: "status", message: "creating" },
      ]);

      const done = applyEvent(doc, statusChange("a", "created", 20));
      const decorate = done.patches[0] as Extract<
        DocumentPatch,
        { kind: "decorate" }
      >;
      expect(decorate.applyResult).toBe("created");
      const timeline2 = done.patches[1] as Extract<
        DocumentPatch,
        { kind: "timeline-append" }
      >;
      expect(timeline2.reset).toBeUndefined();
      expect(doc.timelines.get("a")).toHaveLength(2);
      expect(doc.feed).toHaveLength(2);
    }),
  );

  it.effect("every terminal status maps to a verdict", () =>
    Effect.sync(() => {
      const doc = makeDoc();
      const expected: Record<string, string> = {
        created: "created",
        updated: "updated",
        adopted: "adopted",
        replaced: "replaced",
        deleted: "deleted",
        orphaned: "orphaned",
        ran: "ran",
        skipped: "skipped",
        fail: "failed",
      };
      let ts = 0;
      for (const [status, result] of Object.entries(expected)) {
        applyEvent(doc, statusChange(status, status, ++ts));
        expect(doc.decorations.get(status)?.applyResult).toBe(result);
        expect(doc.decorations.get(status)?.resultAt).toBe(ts);
      }
      // in-flight statuses (including the adoption/orphan phases) reset
      // the timeline but carry no verdict
      for (const status of ["adopting", "orphaning", "updating"]) {
        const { patches } = applyEvent(doc, statusChange(status, status, ++ts));
        const timeline = patches[1] as Extract<
          DocumentPatch,
          { kind: "timeline-append" }
        >;
        expect(timeline.reset).toBe(true);
        expect(doc.decorations.get(status)?.applyResult).toBeUndefined();
      }
    }),
  );

  it.effect("binding status-change only feeds", () =>
    Effect.sync(() => {
      const doc = makeDoc();
      const { patches } = applyEvent(doc, {
        kind: "status-change",
        ts: 5,
        fqn: "api",
        id: "api",
        type: "Test.Function",
        status: "creating",
        bindingId: "MY_BUCKET",
      });
      expect(patches.map((p) => p.kind)).toEqual(["feed-append"]);
      expect(doc.decorations.size).toBe(0);
      expect(doc.feed[0].id).toBe("api/MY_BUCKET");
    }),
  );

  it.effect("log + annotate fold into timeline/decoration + feed", () =>
    Effect.sync(() => {
      const doc = makeDoc();
      const log = applyEvent(doc, {
        kind: "log",
        ts: 3,
        fqn: "a",
        id: "a",
        level: "Info",
        message: "hello",
      });
      expect(log.patches.map((p) => p.kind)).toEqual([
        "timeline-append",
        "feed-append",
      ]);
      expect(doc.timelines.get("a")).toEqual([
        { ts: 3, level: "Info", message: "hello" },
      ]);
      expect(doc.feed[0].log).toBe(true);

      const note = applyEvent(doc, {
        kind: "annotate",
        ts: 4,
        fqn: "a",
        id: "a",
        message: "note!",
      });
      expect(note.patches.map((p) => p.kind)).toEqual([
        "decorate",
        "timeline-append",
        "feed-append",
      ]);
      expect(doc.decorations.get("a")?.note).toBe("note!");
    }),
  );

  it.effect("events without fqn join through the logicalId index", () =>
    Effect.sync(() => {
      const doc = makeDoc();
      applyStates(doc, new Map([["ns/api", createdState("ns/api")]]));
      applyEvent(doc, {
        kind: "status-change",
        ts: 7,
        id: "api",
        type: "Test.Function",
        status: "updating",
      });
      expect(doc.decorations.get("ns/api")?.status).toBe("updating");
      // unknown ids fall back to the id itself (root fqns ARE logicalIds)
      applyEvent(doc, {
        kind: "status-change",
        ts: 8,
        id: "orphan",
        type: "T",
        status: "creating",
      });
      expect(doc.decorations.get("orphan")?.status).toBe("creating");
    }),
  );

  it.effect("op-start/op-end build wait/run spans from the pending ts", () =>
    Effect.sync(() => {
      const doc = makeDoc();
      applyEvent(doc, statusChange("a", "pending", 100));
      const start = applyEvent(doc, {
        kind: "op-start",
        ts: 150,
        fqn: "a",
        id: "a",
        opId: "op-1",
        op: "create",
        phase: "execute",
      });
      expect(start.patches.map((p) => p.kind)).toEqual(["op-span"]);
      const end = applyEvent(doc, {
        kind: "op-end",
        ts: 400,
        fqn: "a",
        id: "a",
        opId: "op-1",
        outcome: "ok",
      });
      expect(end.patches.map((p) => p.kind)).toEqual(["op-span"]);
      expect(doc.opSpans.get("a")).toEqual([
        {
          opId: "op-1",
          op: "create",
          phase: "execute",
          startTs: 150,
          endTs: 400,
          outcome: "ok",
          pendingTs: 100,
        },
      ]);

      const waterfall = waterfallSpansOf(doc);
      expect(waterfall).toEqual([
        {
          fqn: "a",
          segments: [
            { kind: "wait", startTs: 100, endTs: 150 },
            {
              kind: "run",
              startTs: 150,
              endTs: 400,
              outcome: "ok",
              op: "create",
            },
          ],
        },
      ]);

      const [row] = tableRowsOf(doc);
      expect(row.waitMs).toBe(50);
      expect(row.runMs).toBe(250);
    }),
  );

  it.effect("op-end without op-start is tolerated", () =>
    Effect.sync(() => {
      const doc = makeDoc();
      const { patches } = applyEvent(doc, {
        kind: "op-end",
        ts: 9,
        fqn: "a",
        id: "a",
        opId: "ghost-op",
        outcome: "fail",
        error: "boom",
      });
      expect(patches.map((p) => p.kind)).toEqual(["op-span"]);
      expect(doc.opSpans.get("a")).toEqual([
        {
          opId: "ghost-op",
          op: "unknown",
          startTs: 9,
          endTs: 9,
          outcome: "fail",
          error: "boom",
        },
      ]);
      expect(summaryOf(doc).failures).toEqual([
        { fqn: "a", error: "boom", timelineTail: [] },
      ]);
    }),
  );

  it.effect("annotation upserts by context, preserving position", () =>
    Effect.sync(() => {
      const doc = makeDoc();
      applyEvent(doc, {
        kind: "annotation",
        ts: 1,
        context: "migrations",
        style: "info",
        markdown: "running...",
      });
      applyEvent(doc, {
        kind: "annotation",
        ts: 2,
        context: "seeds",
        style: "info",
        markdown: "seeding",
      });
      const { patches } = applyEvent(doc, {
        kind: "annotation",
        ts: 3,
        context: "migrations",
        style: "success",
        markdown: "done",
      });
      expect(patches.map((p) => p.kind)).toEqual(["annotation"]);
      expect(doc.annotations.size).toBe(2);
      expect(annotationsOf(doc)).toEqual([
        { context: "migrations", style: "success", markdown: "done", at: 3 },
        { context: "seeds", style: "info", markdown: "seeding", at: 2 },
      ]);
    }),
  );

  it.effect("deployment-start/end drive the deployment slice", () =>
    Effect.sync(() => {
      const doc = makeDoc();
      // stale spans/annotations from a previous deployment retire
      applyEvent(doc, {
        kind: "op-end",
        ts: 1,
        fqn: "a",
        id: "a",
        opId: "old",
        outcome: "ok",
      });
      const start = applyEvent(
        doc,
        { kind: "deployment-start", command: "deploy" },
        100,
      );
      expect(start.patches.map((p) => p.kind)).toEqual([
        "deployment-reset",
        "deployment",
      ]);
      expect(doc.opSpans.size).toBe(0);
      expect(doc.deployment?.live).toBe(true);
      expect(doc.deployment?.startedAt).toBe(100);
      expect(doc.deployment?.meta.command).toBe("deploy");

      const end = applyEvent(
        doc,
        {
          kind: "deployment-end",
          outcome: "succeeded",
          summary: { counts: { create: 1 } },
        },
        500,
      );
      expect(end.patches.map((p) => p.kind)).toEqual(["deployment"]);
      expect(doc.deployment?.live).toBe(false);
      expect(doc.deployment?.endedAt).toBe(500);
      expect(summaryOf(doc).deployment?.durationMs).toBe(400);
    }),
  );

  it.effect(
    "state-set / state-delete decorate; unknown kinds are ignored",
    () =>
      Effect.sync(() => {
        const doc = makeDoc();
        applyEvent(doc, { kind: "state-set", fqn: "a", status: "creating" }, 5);
        expect(doc.decorations.get("a")?.status).toBe("creating");
        applyEvent(doc, { kind: "state-delete", fqn: "a" }, 6);
        expect(doc.decorations.get("a")?.status).toBe("deleted");

        const revision = doc.revision;
        const unknown = applyEvent(
          doc,
          { kind: "quantum-flux", id: "a" } as unknown as DashboardEvent,
          7,
        );
        expect(unknown.patches).toEqual([]);
        expect(doc.revision).toBe(revision);
        const outputSet = applyEvent(doc, { kind: "output-set" }, 8);
        expect(outputSet.patches).toEqual([]);
      }),
  );

  it.effect("timelines cap at TIMELINE_CAP entries", () =>
    Effect.sync(() => {
      const doc = makeDoc();
      for (let i = 0; i < TIMELINE_CAP + 100; i++) {
        applyEvent(doc, {
          kind: "log",
          ts: i,
          fqn: "a",
          id: "a",
          level: "Info",
          message: `line ${i}`,
        });
      }
      const timeline = doc.timelines.get("a")!;
      expect(timeline).toHaveLength(TIMELINE_CAP);
      expect(timeline[0].message).toBe("line 100");
      expect(timeline.at(-1)!.message).toBe(`line ${TIMELINE_CAP + 99}`);
    }),
  );
});

// ── snapshot + patch-stream equivalence ────────────────────────────────────

describe("document snapshot + patch protocol", () => {
  it.effect("snapshot → fromSnapshot round-trips", () =>
    Effect.sync(() => {
      const doc = makeDoc();
      applyStates(
        doc,
        new Map([
          ["a", createdState("a", { downstream: ["b"] })],
          ["b", createdState("b")],
        ]),
      );
      applyEvent(doc, statusChange("a", "creating", 1));
      applyEvent(doc, statusChange("a", "created", 2));
      applyEvent(doc, {
        kind: "annotation",
        ts: 3,
        context: "ctx",
        style: "info",
        markdown: "hi",
      });
      setOutputs(doc, { url: "https://example.com" });
      setApproval(doc, {
        id: "approval-1",
        plan: { anything: true },
        requestedAt: 4,
      });

      const snapshot = snapshotOf(doc);
      const rebuilt = fromSnapshot(snapshot);
      expect(snapshotOf(rebuilt)).toEqual(snapshot);
      expect(rebuilt.byLogicalId.get("a")).toEqual(["a"]);
      expect(rebuilt.approval?.id).toBe("approval-1");
      // rebuilding never aliases: mutating the rebuilt doc leaves the
      // original untouched
      applyEvent(rebuilt, statusChange("b", "deleting", 9));
      expect(doc.decorations.get("b")).toBeUndefined();
    }),
  );

  it.effect("the patch stream reproduces every mutation", () =>
    Effect.sync(() => {
      const doc = makeDoc();
      const clone = fromSnapshot(snapshotOf(doc));
      const all: DocumentPatch[] = [];
      const track = ({ patches }: { patches: DocumentPatch[] }) =>
        all.push(...patches);

      track(setMeta(doc, { stages: ["test", "prod"] }));
      track(
        applyStates(
          doc,
          new Map([
            ["a", createdState("a", { downstream: ["b"] })],
            ["b", createdState("b")],
          ]),
        ),
      );
      track(
        applyPlan(doc, {
          ...emptyPlan,
          resources: {
            a: {
              fqn: "a",
              logicalId: "a",
              type: "Test.Bucket",
              action: "update",
              downstream: [],
              bindings: [],
            },
          },
          deletions: {
            gone: {
              fqn: "gone",
              logicalId: "gone",
              type: "Test.Bucket",
              action: "delete",
              downstream: [],
              bindings: [],
            },
          },
        }),
      );
      track(
        applyEvent(doc, { kind: "deployment-start", command: "deploy" }, 1),
      );
      track(
        applyDeploymentRecord(doc, {
          stack: "docstack",
          stage: "test",
          version: 3,
          meta: { command: "deploy", initiator: { user: "sam" } },
          startedAt: 1,
          heartbeatAt: 2,
        }),
      );
      track(applyEvent(doc, statusChange("a", "pending", 2)));
      track(applyEvent(doc, statusChange("a", "updating", 3, "changing")));
      track(
        applyEvent(doc, {
          kind: "op-start",
          ts: 4,
          fqn: "a",
          id: "a",
          opId: "op-1",
          op: "update",
        }),
      );
      track(
        applyEvent(doc, {
          kind: "log",
          ts: 5,
          fqn: "a",
          id: "a",
          level: "Info",
          message: "working",
        }),
      );
      track(
        applyEvent(doc, {
          kind: "op-end",
          ts: 6,
          fqn: "a",
          id: "a",
          opId: "op-1",
          outcome: "ok",
        }),
      );
      track(applyEvent(doc, statusChange("a", "updated", 7)));
      // exercise the timeline cap through the patch path too
      for (let i = 0; i < TIMELINE_CAP + 50; i++) {
        track(
          applyEvent(doc, {
            kind: "log",
            ts: 100 + i,
            fqn: "b",
            id: "b",
            level: "Debug",
            message: `noise ${i}`,
          }),
        );
      }
      track(
        applyEvent(doc, {
          kind: "annotation",
          ts: 8,
          context: "ctx",
          style: "warning",
          markdown: "careful",
        }),
      );
      track(
        applyEvent(doc, { kind: "state-set", fqn: "a", status: "updated" }, 9),
      );
      track(
        applyEvent(doc, { kind: "deployment-end", outcome: "succeeded" }, 10),
      );
      track(setOutputs(doc, { api: "https://api.example.com" }));
      track(setApproval(doc, { id: "ap-1", plan: { v: 1 }, requestedAt: 11 }));
      track(clearApproval(doc));

      applyPatches(clone, all);
      expect(snapshotOf(clone)).toEqual(snapshotOf(doc));
      expect(clone.revision).toBe(doc.revision);
    }),
  );
});
