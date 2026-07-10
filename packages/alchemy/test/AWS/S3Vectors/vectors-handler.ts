import * as Lambda from "@/AWS/Lambda";
import * as S3Vectors from "@/AWS/S3Vectors";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "vectors-handler.ts");

export class VectorsTestFunction extends Lambda.Function<Lambda.Function>()(
  "S3VectorsTestFunction",
) {}

export default VectorsTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const bucket = yield* S3Vectors.VectorBucket("VBucket", {});
    const index = yield* S3Vectors.Index("VIndex", {
      vectorBucketName: bucket.vectorBucketName,
      dimension: 4,
      distanceMetric: "cosine",
    });
    const vectors = yield* S3Vectors.Vectors(index);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/put") {
          yield* vectors.put({
            vectors: [
              { key: "a", data: { float32: [1, 0, 0, 0] } },
              { key: "b", data: { float32: [0, 1, 0, 0] } },
              { key: "c", data: { float32: [0.9, 0.1, 0, 0] } },
            ],
          });
          return yield* HttpServerResponse.json({ put: 3 });
        }

        if (request.method === "GET" && pathname === "/query") {
          const result = yield* vectors.query({
            topK: 2,
            queryVector: { float32: [1, 0, 0, 0] },
            returnDistance: true,
          });
          return yield* HttpServerResponse.json({
            keys: result.vectors.map((v) => v.key),
            distanceMetric: result.distanceMetric,
          });
        }

        if (request.method === "GET" && pathname === "/get") {
          const result = yield* vectors.get({
            keys: ["a"],
            returnData: true,
          });
          return yield* HttpServerResponse.json({
            keys: result.vectors.map((v) => v.key),
          });
        }

        if (request.method === "GET" && pathname === "/delete") {
          yield* vectors.delete({ keys: ["b"] });
          return yield* HttpServerResponse.json({ deleted: "b" });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(S3Vectors.VectorsHttp)),
);
