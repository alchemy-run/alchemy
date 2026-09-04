/**
 * Dashboard server: the incremental DocumentHost behind `/api/v2/*`
 * (snapshot, SSE patch stream, deployment history, projections), the
 * apply-event ingest, and the reporter tee that feeds it from a Cli.
 *
 * All tests run against the in-memory scratch state store; deployment
 * history comes from the in-memory fixture (no store on main keeps one
 * yet). No cloud, no real stacks.
 */
import type { DocumentPatch, DocumentSnapshot } from "@/Dashboard/Document.ts";
import type { DashboardPlan } from "@/Dashboard/PlanJson.ts";
import { withDashboardReporter } from "@/Dashboard/Reporter.ts";
import { serve } from "@/Dashboard/Server.ts";
import type { Plan } from "@/Plan.ts";
import { Cli, type ApplyEvent, type CLIService } from "@/Report.ts";
import { State } from "@/State";
import type { StateService } from "@/State/State.ts";
import * as Test from "@/Test/Alchemy";
import { httpServer } from "@/Util/PlatformServices.ts";
import { describe, expect } from "alchemy-test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestLayers, TestResource } from "../test.resources.ts";
import {
  makeHistory,
  statusChange,
  successfulDeployJournal,
} from "./fixtures/history.ts";

const { test } = Test.make({ providers: TestLayers() });

// ── HTTP helpers (test-side; bounded, never hang) ──────────────────────────

const getJson = <A = any>(url: string) =>
  Effect.tryPromise(async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    return {
      status: res.status,
      body: (res.status === 200 ? await res.json() : undefined) as A,
    };
  });

const postJson = (url: string, body: unknown) =>
  Effect.tryPromise(async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return res.status;
  });

type Frame =
  | { kind: "snapshot"; snapshot: DocumentSnapshot }
  | { kind: "patches"; patches: DocumentPatch[] };

interface SseConnection {
  read: (count: number, deadlineMs?: number) => Effect.Effect<Frame[], Error>;
  frames: Frame[];
}

/**
 * Open an SSE connection and expose a bounded frame reader. The reader
 * accumulates every `data:` frame seen so far in `frames`; `read(n)`
 * resolves once at least `n` frames have arrived (or the deadline passes —
 * the server's 8s heartbeat guarantees reads never block longer than that).
 */
const openSse = (url: string) =>
  Effect.acquireRelease(
    Effect.tryPromise(
      async (): Promise<SseConnection & { abort: () => void }> => {
        const controller = new AbortController();
        const res = await fetch(url, { signal: controller.signal });
        if (res.status !== 200 || res.body === null) {
          controller.abort();
          throw new Error(`SSE connect failed: ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const frames: Frame[] = [];
        let buffer = "";
        const pump = async (count: number, deadline: number) => {
          while (frames.length < count) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
              break;
            }
            const chunk = await reader.read();
            if (chunk.done) {
              break;
            }
            buffer += decoder.decode(chunk.value, { stream: true });
            let index: number;
            while ((index = buffer.indexOf("\n\n")) >= 0) {
              const raw = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              if (raw.startsWith("data: ")) {
                frames.push(JSON.parse(raw.slice(6)) as Frame);
              }
            }
          }
          return [...frames];
        };
        return {
          frames,
          read: (count, deadlineMs = 15_000) =>
            Effect.tryPromise(() => pump(count, Date.now() + deadlineMs)).pipe(
              Effect.mapError((e) => new Error(String(e))),
            ),
          abort: () => controller.abort(),
        };
      },
    ),
    (conn) => Effect.sync(() => conn.abort()),
  );

/** Boot the dashboard server for a scratch stack's store. */
const withServer = <A, E>(
  store: StateService,
  stack: string,
  body: (base: string) => Effect.Effect<A, E, any>,
  options?: Partial<Parameters<typeof serve>[0]>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const address = yield* serve({
        state: store,
        stack,
        stage: "test",
        ...options,
      });
      const base = address.replace("0.0.0.0", "127.0.0.1");
      return yield* body(base);
    }).pipe(Effect.provide(httpServer(0, "127.0.0.1"))),
  );

const getStore = Effect.gen(function* () {
  const store: StateService = yield* yield* State;
  return store;
});

const planWith = (
  resources: Record<string, { fqn: string; action: string }>,
): DashboardPlan => ({
  available: true,
  resources: Object.fromEntries(
    Object.entries(resources).map(([fqn, r]) => [
      fqn,
      {
        fqn,
        logicalId: fqn.split("/").at(-1)!,
        type: "Test.TestResource",
        action: r.action as any,
        downstream: [],
        bindings: [],
      },
    ]),
  ),
  deletions: {},
  actions: {},
  cycleMembers: [],
});

/** Read frames until one carries a decorate patch matching `predicate`. */
const readUntilDecorate = (
  sse: SseConnection,
  predicate: (p: Extract<DocumentPatch, { kind: "decorate" }>) => boolean,
) =>
  Effect.gen(function* () {
    const matches = (frames: Frame[]) =>
      frames.some(
        (f) =>
          f.kind === "patches" &&
          f.patches.some((p) => p.kind === "decorate" && predicate(p)),
      );
    let frames = yield* sse.read(2);
    for (let i = 3; i <= 8 && !matches(frames); i++) {
      frames = yield* sse.read(i, 5_000);
    }
    expect(matches(frames)).toBe(true);
    return frames;
  });

describe("dashboard server", () => {
  // ── 1. history-backed store → document, history, projections, SSE ────────

  test.provider(
    "serves the folded document, history and projections for a journaled deploy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.deploy(
          Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a" });
            const B = yield* TestResource("B", { string: A.string });
            return { A, B };
          }),
        );
        const store = yield* getStore;
        const fixture = makeHistory();
        fixture.put({
          stack: stack.name,
          stage: "test",
          version: 1,
          meta: { command: "deploy" },
          startedAt: 1_000,
          heartbeatAt: 2_100,
          endedAt: 2_100,
          outcome: "succeeded",
        });
        fixture.journal(1, successfulDeployJournal(["A", "B"]));

        yield* withServer(
          store,
          stack.name,
          (base) =>
            Effect.gen(function* () {
              // ── /api/v2/document: the hydrated + journal-folded snapshot ──
              const doc = yield* getJson<DocumentSnapshot>(
                `${base}/api/v2/document`,
              );
              expect(doc.status).toBe(200);
              const snapshot = doc.body;
              expect(snapshot.meta).toMatchObject({
                stack: stack.name,
                stage: "test",
              });
              const fqns = snapshot.structure.nodes.map((n) => n.fqn).sort();
              expect(fqns).toEqual(["A", "B"]);
              // the newest journal was folded: last deploy's picture survives
              expect(snapshot.decorations.A?.status).toBe("created");
              expect(snapshot.decorations.B?.applyResult).toBe("created");
              expect(snapshot.deployment?.version).toBe(1);
              expect(snapshot.deployment?.live).toBe(false);
              expect(snapshot.deployment?.outcome).toBe("succeeded");
              expect(Object.keys(snapshot.opSpans).sort()).toEqual(["A", "B"]);

              // ── /api/v2/deployments: history list ──
              const list = yield* getJson<any[]>(`${base}/api/v2/deployments`);
              expect(list.status).toBe(200);
              expect(list.body.map((r) => r.version)).toEqual([1]);
              expect(list.body[0].outcome).toBe("succeeded");

              // ── /api/v2/deployments/1: record + historical snapshot + projections ──
              const detail = yield* getJson<{
                record: any;
                snapshot: DocumentSnapshot;
                projections: {
                  summary: any;
                  tableRows: any[];
                  waterfallSpans: any[];
                  annotations: any[];
                };
              }>(`${base}/api/v2/deployments/1`);
              expect(detail.status).toBe(200);
              expect(detail.body.record.version).toBe(1);
              expect(detail.body.record.meta.command).toBe("deploy");
              // historical overlay rides the CURRENT structure
              expect(
                detail.body.snapshot.structure.nodes.map((n) => n.fqn).sort(),
              ).toEqual(["A", "B"]);
              expect(detail.body.snapshot.decorations.A?.applyResult).toBe(
                "created",
              );
              const rowA = detail.body.projections.tableRows.find(
                (r) => r.fqn === "A",
              );
              expect(rowA?.status).toBe("created");
              expect(typeof rowA?.runMs).toBe("number");
              expect(rowA!.runMs).toBeGreaterThanOrEqual(0);
              expect(detail.body.projections.waterfallSpans.length).toBe(2);
              for (const row of detail.body.projections.waterfallSpans) {
                expect(row.segments.length).toBeGreaterThanOrEqual(1);
              }
              expect(
                detail.body.projections.summary.counts.byApplyResult.created,
              ).toBe(2);
              expect(
                detail.body.projections.summary.deployment?.durationMs,
              ).toBeGreaterThanOrEqual(0);

              // unknown version → 404
              const missing = yield* getJson(`${base}/api/v2/deployments/99`);
              expect(missing.status).toBe(404);

              // ── /api/v2/projections of the LIVE document ──
              const summary = yield* getJson<{ view: string; data: any }>(
                `${base}/api/v2/projections?view=summary`,
              );
              expect(summary.status).toBe(200);
              expect(summary.body.view).toBe("summary");
              expect(summary.body.data.counts.byApplyResult.created).toBe(2);
              const table = yield* getJson<{ data: any[] }>(
                `${base}/api/v2/projections?view=table`,
              );
              expect(table.status).toBe(200);
              expect(table.body.data.map((r: any) => r.fqn).sort()).toEqual([
                "A",
                "B",
              ]);
              const waterfall = yield* getJson<{ data: any[] }>(
                `${base}/api/v2/projections?view=waterfall`,
              );
              expect(waterfall.body.data.length).toBe(2);
              const listView = yield* getJson<{ data: any[] }>(
                `${base}/api/v2/projections?view=list`,
              );
              expect(
                listView.body.data.find((g: any) => g.group === "completed")
                  ?.nodes.length,
              ).toBe(2);
              const badView = yield* getJson(
                `${base}/api/v2/projections?view=nope`,
              );
              expect(badView.status).toBe(400);

              // ── SSE: snapshot frame first ──
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const sse = yield* openSse(`${base}/api/v2/events`);
                  const frames = yield* sse.read(1);
                  expect(frames.length).toBeGreaterThanOrEqual(1);
                  expect(frames[0].kind).toBe("snapshot");
                  const snap = (
                    frames[0] as Extract<Frame, { kind: "snapshot" }>
                  ).snapshot;
                  expect(snap.structure.nodes.map((n) => n.fqn).sort()).toEqual(
                    ["A", "B"],
                  );
                }),
              );

              // ── raw data + health ──
              const resource = yield* getJson<any>(
                `${base}/api/resource?fqn=A`,
              );
              expect(resource.status).toBe(200);
              expect(resource.body.fqn).toBe("A");
              const health = yield* getJson<any>(`${base}/api/health`);
              expect(health.body.ok).toBe(true);
              expect(health.body.stack).toBe(stack.name);
              const unknownApi = yield* getJson(`${base}/api/nope`);
              expect(unknownApi.status).toBe(404);
            }),
          { history: fixture.history },
        );

        // a store without history: history 404s, document works
        yield* withServer(store, stack.name, (base) =>
          Effect.gen(function* () {
            const list = yield* getJson(`${base}/api/v2/deployments`);
            expect(list.status).toBe(404);
            const detail = yield* getJson(`${base}/api/v2/deployments/1`);
            expect(detail.status).toBe(404);
            const doc = yield* getJson<DocumentSnapshot>(
              `${base}/api/v2/document`,
            );
            expect(doc.status).toBe(200);
            expect(doc.body.structure.nodes.map((n) => n.fqn).sort()).toEqual([
              "A",
              "B",
            ]);
            expect(doc.body.deployment).toBeUndefined();
          }),
        );
      }),
    { timeout: 120_000 },
  );

  // ── 2. live path: apply ingest → SSE patch frames; settles without history

  test.provider(
    "streams live apply events as contiguous patch frames",
    (stack) =>
      Effect.gen(function* () {
        const store = yield* getStore;
        yield* withServer(store, stack.name, (base) =>
          Effect.scoped(
            Effect.gen(function* () {
              // subscribe FIRST so the host exists and no patch is missed
              const sse = yield* openSse(`${base}/api/v2/events`);
              const [first] = yield* sse.read(1);
              expect(first.kind).toBe("snapshot");
              const snapshot = (first as Extract<Frame, { kind: "snapshot" }>)
                .snapshot;

              // live apply session (the reporter tee protocol)
              expect(
                yield* postJson(`${base}/api/apply/start`, {
                  sessionId: "live-1",
                  plan: planWith({ A: { fqn: "A", action: "create" } }),
                }),
              ).toBe(200);
              expect(
                yield* postJson(`${base}/api/apply/event`, {
                  sessionId: "live-1",
                  seq: 0,
                  event: statusChange("A", "creating", 100),
                }),
              ).toBe(200);
              expect(
                yield* postJson(`${base}/api/apply/event`, {
                  sessionId: "live-1",
                  seq: 1,
                  event: statusChange("A", "created", 250),
                }),
              ).toBe(200);

              // read until the terminal decoration arrives
              const frames = yield* readUntilDecorate(
                sse,
                (p) => p.fqn === "A" && p.status === "created",
              );

              // every subsequent frame is a patches frame; per the wire
              // protocol clients SKIP patches with revision ≤ the
              // snapshot's, and the accepted ones must continue the
              // snapshot contiguously (no gaps)
              const patches = frames
                .slice(1)
                .flatMap((f) => (f.kind === "patches" ? f.patches : []))
                .filter((p) => p.revision > snapshot.revision);
              expect(patches.length).toBeGreaterThanOrEqual(2);
              const revisions = [
                ...new Set(patches.map((p) => p.revision)),
              ].sort((a, b) => a - b);
              expect(revisions[0]).toBe(snapshot.revision + 1);
              for (let i = 1; i < revisions.length; i++) {
                expect(revisions[i]).toBe(revisions[i - 1] + 1);
              }
              // the plan overlay reached the document as a structure patch
              expect(patches.some((p) => p.kind === "structure-replace")).toBe(
                true,
              );
              // the apply-start bookend opened a live deployment record
              const doc = yield* getJson<DocumentSnapshot>(
                `${base}/api/v2/document`,
              );
              expect(doc.body.decorations.A?.status).toBe("created");
              expect(doc.body.decorations.A?.applyResult).toBe("created");
              expect(doc.body.deployment?.live).toBe(true);
              expect(doc.body.deployment?.meta.command).toBe("deploy");

              // events from an unknown session are ignored
              expect(
                yield* postJson(`${base}/api/apply/event`, {
                  sessionId: "someone-else",
                  seq: 0,
                  event: statusChange("A", "deleting", 300),
                }),
              ).toBe(200);

              // done: without a history the tee's outcome settles the run
              expect(
                yield* postJson(`${base}/api/apply/done`, {
                  sessionId: "live-1",
                  outcome: "failed",
                }),
              ).toBe(200);
              const settled = yield* getJson<DocumentSnapshot>(
                `${base}/api/v2/document`,
              );
              expect(settled.body.decorations.A?.status).toBe("created");
              expect(settled.body.deployment?.live).toBe(false);
              expect(settled.body.deployment?.outcome).toBe("failed");
            }),
          ),
        );
      }),
    { timeout: 120_000 },
  );

  // ── 3. browser approvals ─────────────────────────────────────────────────

  test.provider(
    "approval requests land in the document and resolve through decide",
    (stack) =>
      Effect.gen(function* () {
        const store = yield* getStore;
        yield* withServer(store, stack.name, (base) =>
          Effect.gen(function* () {
            expect(
              yield* postJson(`${base}/api/approval/request`, {
                id: "ap-1",
                plan: planWith({ A: { fqn: "A", action: "create" } }),
              }),
            ).toBe(200);
            const pending = yield* getJson<DocumentSnapshot>(
              `${base}/api/v2/document`,
            );
            expect(pending.body.approval?.id).toBe("ap-1");
            expect(pending.body.structure.nodes.map((n) => n.fqn)).toEqual([
              "A",
            ]);
            expect(pending.body.structure.nodes[0].planAction).toBe("create");

            const undecided = yield* getJson<{ approved: boolean | null }>(
              `${base}/api/approval/status?id=ap-1`,
            );
            expect(undecided.body.approved).toBeNull();

            expect(
              yield* postJson(`${base}/api/approval/decide`, {
                id: "ap-1",
                approved: false,
              }),
            ).toBe(200);
            const decided = yield* getJson<{ approved: boolean | null }>(
              `${base}/api/approval/status?id=ap-1`,
            );
            expect(decided.body.approved).toBe(false);
            // rejection clears the pending approval from the document
            const cleared = yield* getJson<DocumentSnapshot>(
              `${base}/api/v2/document`,
            );
            expect(cleared.body.approval).toBeUndefined();
            // unknown ids never resolve
            const unknown = yield* getJson<{ approved: boolean | null }>(
              `${base}/api/approval/status?id=nope`,
            );
            expect(unknown.body.approved).toBeNull();
          }),
        );
      }),
    { timeout: 60_000 },
  );

  // ── 4. restart catch-up: open journal folds at host creation ─────────────

  test.provider(
    "rebuilds the in-flight picture from an open deployment journal",
    (stack) =>
      Effect.gen(function* () {
        const store = yield* getStore;
        const fixture = makeHistory();
        const startedAt = Date.now() - 5_000;
        fixture.put({
          stack: stack.name,
          stage: "test",
          version: 4,
          meta: { command: "deploy", initiator: { user: "restart-test" } },
          startedAt,
          heartbeatAt: Date.now(),
        });
        fixture.journal(4, [
          {
            ts: startedAt,
            payload: { kind: "deployment-start", command: "deploy" },
          },
          {
            ts: startedAt + 100,
            fqn: "A",
            payload: statusChange("A", "pending", startedAt + 100),
          },
          {
            ts: startedAt + 200,
            fqn: "A",
            payload: statusChange("A", "creating", startedAt + 200),
          },
          {
            ts: startedAt + 250,
            fqn: "A",
            payload: {
              kind: "op-start",
              ts: startedAt + 250,
              fqn: "A",
              id: "A",
              opId: "op-1",
              op: "create",
              phase: "execute",
            },
          },
        ]);

        // the server starts AFTER the journal exists, mid-deploy
        yield* withServer(
          store,
          stack.name,
          (base) =>
            Effect.gen(function* () {
              const doc = yield* getJson<DocumentSnapshot>(
                `${base}/api/v2/document`,
              );
              expect(doc.status).toBe(200);
              expect(doc.body.deployment?.version).toBe(4);
              expect(doc.body.deployment?.live).toBe(true);
              expect(doc.body.deployment?.meta.initiator?.user).toBe(
                "restart-test",
              );
              expect(doc.body.decorations.A?.status).toBe("creating");
              const spans = doc.body.opSpans.A ?? [];
              expect(spans).toHaveLength(1);
              expect(spans[0].op).toBe("create");
              expect(spans[0].endTs).toBeUndefined();
              expect(spans[0].pendingTs).toBe(startedAt + 100);

              const summary = yield* getJson<{ data: any }>(
                `${base}/api/v2/projections?view=summary`,
              );
              expect(summary.body.data.deployment?.live).toBe(true);
            }),
          { history: fixture.history },
        );
      }),
    { timeout: 120_000 },
  );

  // ── 5. the reporter tee: engine ApplyEvents reach the dashboard ──────────

  test.provider(
    "the reporter tee streams a Cli apply session into the dashboard",
    (stack) =>
      Effect.gen(function* () {
        const store = yield* getStore;
        yield* withServer(store, stack.name, (base) =>
          Effect.scoped(
            Effect.gen(function* () {
              // a Cli that records what the tee forwards to it
              const seen: ApplyEvent[] = [];
              let doneWith: string | undefined;
              const inner: CLIService = {
                startPlanningSession: () =>
                  Effect.succeed({
                    update: () => Effect.void,
                    succeed: () => Effect.void,
                    fail: () => Effect.void,
                    close: Effect.void,
                  }),
                approvePlan: () => Effect.succeed(true),
                displayPlan: () => Effect.void,
                startApplySession: () =>
                  Effect.succeed({
                    emit: (event) =>
                      Effect.sync(() => {
                        seen.push(event);
                      }),
                    done: (outcome) =>
                      Effect.sync(() => {
                        doneWith = outcome;
                      }),
                  }),
              };
              const cli = withDashboardReporter(
                Layer.succeed(Cli, Cli.of(inner)),
                { locate: Effect.succeed({ url: base }) },
              );
              const context = yield* Layer.build(cli);
              const teed = Context.get(context, Cli);

              // subscribe before the run so every patch is observed
              const sse = yield* openSse(`${base}/api/v2/events`);
              yield* sse.read(1);

              const plan = {
                resources: {},
                actions: {},
                deletions: {},
                actionDeletions: {},
                output: undefined,
                cycleMembers: new Set<string>(),
              } as unknown as Plan;
              const session = yield* teed.startApplySession(plan);
              yield* session.emit({
                _tag: "apply.resource.status",
                fqn: "A",
                id: "A",
                type: "Test.TestResource",
                status: "creating",
              });
              yield* session.emit({
                _tag: "apply.resource.note",
                fqn: "A",
                id: "A",
                message: "uploading",
              });
              yield* session.emit({
                _tag: "apply.resource.status",
                fqn: "A",
                id: "A",
                type: "Test.TestResource",
                status: "created",
              });
              yield* session.done("success");

              // the inner Cli saw everything, untouched
              expect(seen.map((e) => e._tag)).toEqual([
                "apply.resource.status",
                "apply.resource.note",
                "apply.resource.status",
              ]);
              expect(doneWith).toBe("success");

              // the dashboard folded the adapted events
              yield* readUntilDecorate(
                sse,
                (p) => p.fqn === "A" && p.status === "created",
              );
              const doc = yield* getJson<DocumentSnapshot>(
                `${base}/api/v2/document`,
              );
              expect(doc.body.decorations.A?.applyResult).toBe("created");
              expect(doc.body.decorations.A?.note).toBe("uploading");
              expect(doc.body.timelines.A?.map((t) => t.level)).toEqual([
                "status",
                "note",
                "status",
              ]);
              // every entry carries the engine-side emission ts
              for (const entry of doc.body.timelines.A ?? []) {
                expect(entry.ts).toBeGreaterThan(0);
              }
              expect(doc.body.deployment?.live).toBe(false);
              expect(doc.body.deployment?.outcome).toBe("succeeded");
            }),
          ),
        );
      }),
    { timeout: 120_000 },
  );
});
