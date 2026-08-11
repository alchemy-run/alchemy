/**
 * Dashboard v2 server: the incremental DocumentHost + the additive
 * `/api/v2/*` endpoints (snapshot, SSE patch stream, deployment history,
 * projections) — while every v1 endpoint keeps working unchanged.
 *
 * All tests run against the in-memory scratch state store (with its
 * journal-backed `deployments` support); no cloud, no real stacks.
 */
import type { DocumentPatch, DocumentSnapshot } from "@/Dashboard/Document.ts";
import { serve } from "@/Dashboard/Server.ts";
import type { DashboardPlan } from "@/Dashboard/PlanJson.ts";
import type { ApplyEvent } from "@/Cli/Event.ts";
import { State } from "@/State";
import type { StateService } from "@/State/State.ts";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { httpServer } from "@/Util/PlatformServices.ts";
import { TestLayers, TestResource } from "../test.resources.ts";

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

/** Boot the v1+v2 dashboard server for a scratch stack's store. */
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
  const store = yield* yield* State;
  expect(store.deployments).toBeDefined();
  return store;
});

const statusChange = (fqn: string, status: string, ts: number): ApplyEvent =>
  ({
    kind: "status-change",
    ts,
    fqn,
    id: fqn.split("/").at(-1)!,
    type: "Test.Resource",
    status,
  }) as ApplyEvent;

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
        type: "Test.Resource",
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

// ── 1. journaled deploy → v2 document, history, projections, SSE ───────────

describe("dashboard v2 server", () => {
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

        yield* withServer(store, stack.name, (base) =>
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
            expect(
              detail.body.projections.waterfallSpans.length,
            ).toBeGreaterThanOrEqual(2);
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
            expect(waterfall.body.data.length).toBeGreaterThanOrEqual(2);
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
                const snap = (frames[0] as Extract<Frame, { kind: "snapshot" }>)
                  .snapshot;
                expect(snap.structure.nodes.map((n) => n.fqn).sort()).toEqual([
                  "A",
                  "B",
                ]);
              }),
            );

            // ── v1 regression: the scene endpoint still works ──
            const scene = yield* getJson<any>(`${base}/api/scene`);
            expect(scene.status).toBe(200);
            expect(scene.body.stack).toBe(stack.name);
            expect(scene.body.nodes.map((n: any) => n.fqn).sort()).toEqual([
              "A",
              "B",
            ]);
            const health = yield* getJson<any>(`${base}/api/health`);
            expect(health.body.ok).toBe(true);
          }),
        );

        // a store without deployments support: history 404s, document works
        const bare: StateService = { ...store, deployments: undefined };
        yield* withServer(bare, stack.name, (base) =>
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

  // ── 2. live path: apply ingest → SSE patch frames; v1 unaffected ─────────

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

              // live apply session (the v1 reporter tee protocol)
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
              const hasCreated = (frames: Frame[]) =>
                frames.some(
                  (f) =>
                    f.kind === "patches" &&
                    f.patches.some(
                      (p) =>
                        p.kind === "decorate" &&
                        p.fqn === "A" &&
                        p.status === "created",
                    ),
                );
              let frames = yield* sse.read(2);
              for (let i = 3; i <= 8 && !hasCreated(frames); i++) {
                frames = yield* sse.read(i, 5_000);
              }
              expect(hasCreated(frames)).toBe(true);

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

              // v1 regression: the scene still assembles with the live
              // session applied
              const scene = yield* getJson<any>(`${base}/api/scene`);
              expect(scene.status).toBe(200);
              expect(scene.body.session?.id).toBe("live-1");
              const nodeA = scene.body.nodes.find((n: any) => n.fqn === "A");
              expect(nodeA?.status).toBe("created");

              // and the v2 document agrees
              const doc = yield* getJson<DocumentSnapshot>(
                `${base}/api/v2/document`,
              );
              expect(doc.body.decorations.A?.status).toBe("created");
              expect(doc.body.decorations.A?.applyResult).toBe("created");

              yield* postJson(`${base}/api/apply/done`, {
                sessionId: "live-1",
              });
            }),
          ),
        );
      }),
    { timeout: 120_000 },
  );

  // ── 3. restart catch-up: open journal folds at host creation ─────────────

  test.provider(
    "rebuilds the in-flight picture from an open deployment journal",
    (stack) =>
      Effect.gen(function* () {
        const store = yield* getStore;
        const deployments = store.deployments!;
        const opened = yield* deployments.begin({
          stack: stack.name,
          stage: "test",
          meta: { command: "deploy", initiator: { user: "restart-test" } },
        });
        yield* deployments.appendEvents({
          stack: stack.name,
          stage: "test",
          version: opened.version,
          token: opened.token,
          events: [
            {
              seq: 1,
              ts: 1_000,
              payload: { kind: "deployment-start", command: "deploy" },
            },
            {
              seq: 2,
              ts: 1_100,
              fqn: "A",
              payload: statusChange("A", "pending", 1_100),
            },
            {
              seq: 3,
              ts: 1_200,
              fqn: "A",
              payload: statusChange("A", "creating", 1_200),
            },
            {
              seq: 4,
              ts: 1_250,
              fqn: "A",
              payload: {
                kind: "op-start",
                ts: 1_250,
                fqn: "A",
                id: "A",
                opId: "op-1",
                op: "create",
                phase: "execute",
              },
            },
          ],
        });

        // the server starts AFTER the journal exists, mid-deploy
        yield* withServer(store, stack.name, (base) =>
          Effect.gen(function* () {
            const doc = yield* getJson<DocumentSnapshot>(
              `${base}/api/v2/document`,
            );
            expect(doc.status).toBe(200);
            expect(doc.body.deployment?.version).toBe(opened.version);
            expect(doc.body.deployment?.live).toBe(true);
            expect(doc.body.deployment?.meta.initiator?.user).toBe(
              "restart-test",
            );
            expect(doc.body.decorations.A?.status).toBe("creating");
            const spans = doc.body.opSpans.A ?? [];
            expect(spans).toHaveLength(1);
            expect(spans[0].op).toBe("create");
            expect(spans[0].endTs).toBeUndefined();
            expect(spans[0].pendingTs).toBe(1_100);

            const summary = yield* getJson<{ data: any }>(
              `${base}/api/v2/projections?view=summary`,
            );
            expect(summary.body.data.deployment?.live).toBe(true);
          }),
        );

        // release the lease so the harness teardown can deploy/destroy
        yield* deployments.end({
          stack: stack.name,
          stage: "test",
          version: opened.version,
          token: opened.token,
          outcome: "interrupted",
        });
      }),
    { timeout: 120_000 },
  );
});
