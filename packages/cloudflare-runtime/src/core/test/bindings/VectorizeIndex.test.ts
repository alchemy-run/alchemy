import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Vectorize from "../../bindings/Vectorize.ts";
import type { VectorizeProps } from "../../bindings/VectorizeOptions.shared.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const script = `export default { async fetch(request, env) {
  const { binding = "INDEX", method, args = [] } = await request.json();
  try { return Response.json(await env[binding][method](...args)); }
  catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
}};`;
const metadataIndexes = {
  category: "string",
  price: "number",
  "nested.active": "boolean",
} as const;
const vectors = [
  {
    id: "a",
    values: [1, 0],
    namespace: "first",
    metadata: {
      category: "book",
      price: 12,
      nested: { active: true },
      private: "hidden",
    },
  },
  {
    id: "b",
    values: [0, 2],
    namespace: "second",
    metadata: { category: "film", price: 20 },
  },
  {
    id: "c",
    values: [1, 1],
    namespace: "first",
    metadata: { category: "book", price: 15 },
  },
];
const config = (name: string, props: Partial<VectorizeProps> = {}) => ({
  name,
  compatibilityDate: "2026-03-10",
  compatibilityFlags: [],
  modules: [{ name: "main.js", type: "ESModule" as const, content: script }],
  bindings: [
    Vectorize.local({
      binding: "INDEX",
      indexName: name,
      dimensions: 2,
      metadataIndexes,
      ...props,
    }),
  ],
});
const invoke = (
  worker: Awaited<Effect.Success<ReturnType<typeof startTestWorker>>>,
  method: string,
  args: unknown[] = [],
) =>
  worker.fetchJson<any>("/", {
    method: "POST",
    body: JSON.stringify({ method, args }),
  });

layer(localRuntimeLayer)("Vectorize native search behavior", (it) => {
  for (const [metric, ids, firstScore] of [
    ["cosine", ["a", "c", "b"], 1],
    ["euclidean", ["a", "c", "b"], 0],
    ["dot-product", ["b", "c", "a"], 4],
  ] as const)
    it.effect(`ranks by ${metric}`, () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker(
          config(`ranking-${metric}`, { metric }),
        );
        yield* invoke(worker, "upsert", [vectors]);
        const result = yield* invoke(worker, "query", [
          metric === "dot-product" ? [1, 2] : [1, 0],
        ]);
        expect(result.matches.map((v: { id: string }) => v.id)).toEqual(ids);
        expect(result.matches[0].score).toBeCloseTo(firstScore);
      }),
    );

  it.effect(
    "filters metadata and namespaces before topK and selects returned fields",
    () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker(config("metadata-behavior"));
        yield* invoke(worker, "upsert", [vectors]);
        for (const [filter, ids] of [
          [{ category: "book" }, ["a", "c"]],
          [{ category: { $eq: "film" } }, ["b"]],
          [{ category: { $ne: "book" } }, ["b"]],
          [{ category: { $in: ["book"] } }, ["a", "c"]],
          [{ category: { $nin: ["book"] } }, ["b"]],
          [{ price: { $gte: 12, $lt: 20 } }, ["a", "c"]],
          [{ price: { $gt: 12, $lte: 20 } }, ["b", "c"]],
          [{ "nested.active": true }, ["a"]],
          [{ category: "book", price: { $gt: 12 } }, ["c"]],
        ] as const) {
          const result = yield* invoke(worker, "query", [[1, 0], { filter }]);
          expect(
            result.matches.map((v: { id: string }) => v.id).sort(),
          ).toEqual([...ids].sort());
        }
        const byId = yield* invoke(worker, "queryById", [
          "a",
          { namespace: "first", topK: 1, filter: { price: { $gte: 13 } } },
        ]);
        expect(byId.matches.map((v: { id: string }) => v.id)).toEqual(["c"]);
        expect(
          (yield* invoke(worker, "queryById", ["a", { topK: 1 }])).matches[0],
        ).toEqual({ id: "a", score: 1, namespace: "first" });
        expect(
          (yield* invoke(worker, "queryById", [
            "a",
            { topK: 1, returnMetadata: "indexed", returnValues: true },
          ])).matches[0],
        ).toMatchObject({
          values: [1, 0],
          metadata: { category: "book", price: 12, "nested.active": true },
        });
        expect(
          (yield* invoke(worker, "queryById", [
            "a",
            { topK: 1, returnMetadata: "all" },
          ])).matches[0].metadata,
        ).toEqual(vectors[0]!.metadata);
      }),
  );

  it.effect(
    "preserves full metadata while indexing UTF-8 prefixes and Float32 vectors",
    () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker(config("unicode-behavior"));
        yield* invoke(worker, "upsert", [
          [
            {
              id: "unicode",
              values: [0.1, 0.2],
              metadata: { category: "🐈".repeat(17) },
            },
          ],
        ]);
        const stored = (yield* invoke(worker, "getByIds", [["unicode"]]))[0];
        expect(stored.values[0]).toBe(Math.fround(0.1));
        expect(stored.metadata.category).toBe("🐈".repeat(17));
        expect(
          (yield* invoke(worker, "queryById", [
            "unicode",
            { returnMetadata: "indexed" },
          ])).matches[0].metadata.category,
        ).toBe("🐈".repeat(16));
      }),
  );

  it.effect(
    "rejects invalid filters, dimensions, vectors, topK and missing IDs",
    () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker(config("validation-behavior"));
        yield* invoke(worker, "upsert", [vectors]);
        for (const filter of [
          {},
          { missing: "x" },
          { price: { $regex: ".*" } },
          { price: { $eq: 1, $ne: 2 } },
          { price: { $gte: true } },
        ])
          expect(
            (yield* invoke(worker, "query", [[1, 0], { filter }])).error,
          ).toBeTypeOf("string");
        for (const values of [[1], [null, 0]])
          expect(
            (yield* invoke(worker, "upsert", [[{ id: "invalid", values }]]))
              .error,
          ).toBeTypeOf("string");
        expect(
          (yield* invoke(worker, "queryById", ["missing"])).error,
        ).toBeTypeOf("string");
        expect(
          (yield* invoke(worker, "query", [
            [1, 0],
            { topK: 101, returnValues: true },
          ])).error,
        ).toBeTypeOf("string");
        expect(
          (yield* invoke(worker, "query", [[1, 0], { topK: 1000 }])).matches
            .length,
        ).toBe(3);
        const invalid = yield* startTestWorker(
          config("invalid-config", { dimensions: 0 }),
        );
        expect((yield* invoke(invalid, "describe")).error).toBeTypeOf("string");
      }),
  );

  it.effect(
    "does not retroactively index vectors after adding a metadata index",
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        let worker = yield* startTestWorker(
          config("metadata-added", { metadataIndexes: {} }),
        ).pipe(Effect.provideService(Scope.Scope, scope));
        yield* invoke(worker, "upsert", [
          [{ id: "old", values: [1, 0], metadata: { category: "book" } }],
        ]);
        yield* Scope.close(scope, Exit.void);
        worker = yield* startTestWorker(config("metadata-added"));
        expect(
          (yield* invoke(worker, "query", [
            [1, 0],
            { filter: { category: "book" } },
          ])).count,
        ).toBe(0);
      }),
  );
});
