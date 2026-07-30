/**
 * Hosted dashboard viewer: the read-only `/api` surface over a bare
 * StateService — no CLI process, no plan/structure workers, no approvals.
 *
 * All tests run against the in-memory scratch state store (with its
 * journal-backed `deployments` support); no cloud, no real stacks.
 */
import type { DocumentSnapshot } from "@/Dashboard/Document.ts";
import { viewer } from "@/Dashboard/Viewer.ts";
import { State } from "@/State";
import type { StateService } from "@/State/State.ts";
import * as Test from "@/Test/Alchemy";
import { httpServer } from "@/Util/PlatformServices.ts";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpServer from "effect/unstable/http/HttpServer";
import { TestLayers, TestResource } from "../test.resources.ts";

const { test } = Test.make({ providers: TestLayers() });

const getJson = <A = any>(url: string) =>
  Effect.tryPromise(async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    return {
      status: res.status,
      body: (res.status === 200 ? await res.json() : undefined) as A,
    };
  });

/** Boot the viewer handler alone — exactly what a hosted worker serves. */
const withViewer = <A, E>(
  options: Parameters<typeof viewer>[0],
  body: (base: string) => Effect.Effect<A, E, any>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      yield* server.serve(viewer(options));
      const base = HttpServer.formatAddress(server.address).replace(
        "0.0.0.0",
        "127.0.0.1",
      );
      return yield* body(base);
    }).pipe(Effect.provide(httpServer(0, "127.0.0.1"))),
  );

const getStore = Effect.gen(function* () {
  const store: StateService = yield* yield* State;
  return store;
});

describe("dashboard viewer", () => {
  test.provider(
    "serves the document, history, projections and outputs from the store alone",
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

        // no stack/stage options: the viewer resolves them from the store
        yield* withViewer({ state: store }, (base) =>
          Effect.gen(function* () {
            const health = yield* getJson(`${base}/api/health`);
            expect(health.status).toBe(200);
            expect(health.body).toMatchObject({
              ok: true,
              mode: "viewer",
              stack: stack.name,
              stage: "test",
            });

            const stacks = yield* getJson<
              { stack: string; stages: string[] }[]
            >(`${base}/api/stacks`);
            expect(stacks.status).toBe(200);
            expect(stacks.body).toEqual([
              { stack: stack.name, stages: ["test"] },
            ]);

            const doc = yield* getJson<DocumentSnapshot>(
              `${base}/api/v2/document`,
            );
            expect(doc.status).toBe(200);
            expect(doc.body.meta).toMatchObject({
              stack: stack.name,
              stage: "test",
            });
            expect(doc.body.structure.nodes.map((n) => n.fqn).sort()).toEqual([
              "A",
              "B",
            ]);
            // the newest journal was folded in
            expect(doc.body.deployment?.version).toBe(1);
            expect(doc.body.decorations.A?.applyResult).toBe("created");

            const history = yield* getJson<{ version: number }[]>(
              `${base}/api/v2/deployments`,
            );
            expect(history.status).toBe(200);
            expect(history.body.map((r) => r.version)).toEqual([1]);

            const detail = yield* getJson<{
              record: { version: number };
              snapshot: DocumentSnapshot;
              projections: { summary: unknown; tableRows: unknown[] };
            }>(`${base}/api/v2/deployments/1`);
            expect(detail.status).toBe(200);
            expect(detail.body.record.version).toBe(1);
            expect(
              detail.body.snapshot.structure.nodes.map((n) => n.fqn).sort(),
            ).toEqual(["A", "B"]);
            expect(detail.body.projections.tableRows.length).toBeGreaterThan(0);

            const projections = yield* getJson<{
              view: string;
              data: unknown[];
            }>(`${base}/api/v2/projections?view=table`);
            expect(projections.status).toBe(200);
            expect(projections.body.view).toBe("table");

            const outputs = yield* getJson(`${base}/api/outputs`);
            expect(outputs.status).toBe(200);

            // approvals are CLI-local: the viewer always reports none
            const scene = yield* getJson(`${base}/api/scene`);
            expect(scene.status).toBe(200);
            expect(scene.body).toEqual({ approval: null });

            const missing = yield* getJson(`${base}/api/v2/deployments/999`);
            expect(missing.status).toBe(404);
            const unknown = yield* getJson(`${base}/nope`);
            expect(unknown.status).toBe(404);
          }),
        );
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "explicit ?stack= / ?stage= select the target; unknown targets 404 nothing",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.deploy(
          Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a" });
            return { A };
          }),
        );
        const store = yield* getStore;
        yield* withViewer(
          { state: store, stack: stack.name, stage: "test" },
          (base) =>
            Effect.gen(function* () {
              const doc = yield* getJson<DocumentSnapshot>(
                `${base}/api/v2/document?stack=${encodeURIComponent(stack.name)}&stage=test`,
              );
              expect(doc.status).toBe(200);
              expect(doc.body.structure.nodes.map((n) => n.fqn)).toEqual(["A"]);

              // a stage with no state still serves an (empty) document
              const empty = yield* getJson<DocumentSnapshot>(
                `${base}/api/v2/document?stage=ghost`,
              );
              expect(empty.status).toBe(200);
              expect(empty.body.structure.nodes).toEqual([]);
            }),
        );
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "SSE delivers one snapshot frame to a fresh subscriber",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.deploy(
          Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a" });
            return { A };
          }),
        );
        const store = yield* getStore;
        yield* withViewer({ state: store }, (base) =>
          Effect.tryPromise(async () => {
            const controller = new AbortController();
            try {
              const res = await fetch(`${base}/api/v2/events`, {
                signal: controller.signal,
              });
              expect(res.status).toBe(200);
              expect(res.headers.get("content-type")).toContain(
                "text/event-stream",
              );
              const reader = res.body!.getReader();
              const decoder = new TextDecoder();
              let buffer = "";
              const deadline = Date.now() + 15_000;
              while (!buffer.includes("\n\n") && Date.now() < deadline) {
                const chunk = await reader.read();
                if (chunk.done) {
                  break;
                }
                buffer += decoder.decode(chunk.value, { stream: true });
              }
              const raw = buffer.slice(0, buffer.indexOf("\n\n"));
              expect(raw.startsWith("data: ")).toBe(true);
              const frame = JSON.parse(raw.slice(6)) as {
                kind: string;
                snapshot: DocumentSnapshot;
              };
              expect(frame.kind).toBe("snapshot");
              expect(frame.snapshot.structure.nodes.map((n) => n.fqn)).toEqual([
                "A",
              ]);
            } finally {
              controller.abort();
            }
          }),
        );
      }),
    { timeout: 60_000 },
  );
});
