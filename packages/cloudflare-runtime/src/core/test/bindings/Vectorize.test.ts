import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Vectorize from "../../bindings/Vectorize.ts";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const script = `export default { async fetch(request, env) {
  const { binding = "INDEX", method, args = [] } = await request.json();
  try { return Response.json(await env[binding][method](...args)); }
  catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
}};`;

layer(localRuntimeLayer)("Vectorize local binding", (it) => {
  it.effect(
    "persists mutations, shares an index across bindings, isolates indexes and survives restart",
    () =>
      Effect.gen(function* () {
        const config = {
          name: "vectorize-local",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          modules: [
            { name: "main.js", type: "ESModule" as const, content: script },
          ],
          bindings: [
            Vectorize.local({
              binding: "INDEX",
              indexName: "shared",
              dimensions: 2,
              metadataIndexes: { category: "string" },
            }),
            Vectorize.local({
              binding: "ALIAS",
              indexName: "shared",
              dimensions: 2,
              metadataIndexes: { category: "string" },
            }),
            Vectorize.local({
              binding: "OTHER",
              indexName: "other",
              dimensions: 2,
            }),
          ],
        };
        const workerScope = yield* Scope.make();
        let worker = yield* startTestWorker(config).pipe(
          Effect.provideService(Scope.Scope, workerScope),
        );
        const call = (
          method: string,
          args: unknown[] = [],
          binding = "INDEX",
        ) =>
          worker.fetchJson<any>("/", {
            method: "POST",
            body: JSON.stringify({ method, args, binding }),
          });
        const mutation = yield* call("insert", [
          [
            { id: "a", values: [1, 0], metadata: { category: "book" } },
            { id: "b", values: [0, 1], namespace: "other" },
          ],
        ]);
        expect(mutation.mutationId).toBeTypeOf("string");
        expect((yield* call("describe")).vectorCount).toBe(2);
        expect((yield* call("describe", [], "OTHER")).vectorCount).toBe(0);
        expect((yield* call("getByIds", [["a"]], "ALIAS"))[0].values).toEqual([
          1, 0,
        ]);
        yield* call("insert", [[{ id: "a", values: [9, 9] }]]);
        expect((yield* call("getByIds", [["a"]]))[0].values).toEqual([1, 0]);
        expect(
          (yield* call("queryById", [
            "a",
            {
              topK: 1,
              filter: { category: "book" },
              returnMetadata: "indexed",
            },
          ])).matches[0].metadata,
        ).toEqual({ category: "book" });
        yield* call("upsert", [[{ id: "a", values: [2, 0] }]]);
        expect((yield* call("getByIds", [["a"]]))[0]).toEqual({
          id: "a",
          values: [2, 0],
        });
        const invalid = yield* call("upsert", [
          [
            { id: "valid", values: [1, 0] },
            { id: "invalid", values: [1] },
          ],
        ]);
        expect(invalid.error).toContain("dimensions");
        expect(yield* call("getByIds", [["valid"]])).toEqual([]);
        yield* Scope.close(workerScope, Exit.void);
        worker = yield* startTestWorker(config);
        expect((yield* call("getByIds", [["a"]]))[0].values).toEqual([2, 0]);
        yield* Effect.all(
          Array.from({ length: 10 }, (_, i) =>
            call("upsert", [[{ id: `parallel-${i}`, values: [i, 0] }]]),
          ),
          { concurrency: 10 },
        );
        expect((yield* call("describe")).vectorCount).toBe(12);
        yield* call("deleteByIds", [["a", "missing"]]);
        yield* call("deleteByIds", [["a"]]);
        expect(yield* call("getByIds", [["a"]])).toEqual([]);
        expect((yield* call("describe")).vectorCount).toBe(11);
      }),
  );
});
