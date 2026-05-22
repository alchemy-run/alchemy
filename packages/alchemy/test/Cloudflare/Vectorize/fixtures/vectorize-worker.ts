import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Vectorize index created at deploy time and bound to the worker via
 * `Cloudflare.VectorizeConnection.bind(...)`. The handlers exercise the
 * Effect-native Vectorize client surface:
 *
 *   POST /upsert     — `index.upsert([...])`
 *   GET  /describe   — `index.describe()`
 *   GET  /query      — `index.query(vector, { topK })`
 *   GET  /get        — `index.getByIds([...])`
 */
export const TestIndex = Cloudflare.VectorizeIndex("VectorizeWorkerIndex", {
  dimensions: 3,
  metric: "cosine",
});

export default class VectorizeWorker extends Cloudflare.Worker<VectorizeWorker>()(
  "VectorizeEffectWorker",
  {
    main: import.meta.filename,
    subdomain: { enabled: true },
    compatibility: { date: "2024-09-23", flags: ["nodejs_compat"] },
  },
  Effect.gen(function* () {
    const index = yield* TestIndex;
    const vec = yield* Cloudflare.VectorizeConnection.bind(index);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (request.method === "POST" && url.pathname === "/upsert") {
          const mutation = yield* vec.upsert([
            { id: "a", values: [0.1, 0.2, 0.3], metadata: { kind: "first" } },
            { id: "b", values: [0.9, 0.8, 0.7], metadata: { kind: "second" } },
            { id: "c", values: [0.4, 0.5, 0.6], metadata: { kind: "third" } },
          ]);
          return yield* HttpServerResponse.json({
            mutationId: mutation.mutationId,
          });
        }

        if (request.method === "GET" && url.pathname === "/describe") {
          const info = yield* vec.describe();
          return yield* HttpServerResponse.json({
            dimensions: info.dimensions,
            vectorCount: info.vectorCount,
          });
        }

        if (request.method === "GET" && url.pathname === "/query") {
          const matches = yield* vec.query([0.1, 0.2, 0.3], {
            topK: 3,
            returnMetadata: "all",
          });
          return yield* HttpServerResponse.json({
            count: matches.count,
            ids: matches.matches.map((m) => m.id),
          });
        }

        if (request.method === "GET" && url.pathname === "/get") {
          const vectors = yield* vec.getByIds(["a", "b"]);
          return yield* HttpServerResponse.json({
            ids: vectors.map((v) => v.id).sort(),
          });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.VectorizeConnectionLive)),
) {}
