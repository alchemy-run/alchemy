import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import { assert, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { HttpClientResponse } from "effect/unstable/http";
import * as HttpClient from "effect/unstable/http/HttpClient";
import VectorizeWorker from "./fixtures/vectorize-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/**
 * End-to-end test of `Cloudflare.VectorizeIndex.bind(...)` against a
 * real Cloudflare Worker + Vectorize index.
 *
 * The worker exercises the client surface (`upsert`, `describe`, `query`,
 * `getByIds`). Vectorize mutations are eventually consistent, so after
 * upserting we retry the query/get routes until the vectors are visible.
 */
test.provider(
  "VectorizeIndex.bind exercises the client surface",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const workerUrl = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* VectorizeWorker;
          }),
        )
        .pipe(
          Effect.flatMap((worker) => {
            assert.typeOf(worker.url, "string");
            return HttpClient.get(`${worker.url}/health`).pipe(
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.retry({
                schedule: Schedule.exponential("500 millis").pipe(
                  Schedule.both(Schedule.recurs(20)),
                ),
              }),
              Effect.as(worker.url),
            );
          }),
        );

      // Fresh workers.dev URLs take a few seconds to start serving 200s.
      // Retry the upsert until the route handler responds.
      const upsertRes = yield* HttpClient.post(`${workerUrl}/upsert`).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((res) => res.json),
      );
      expect(upsertRes).toMatchObject({ mutationId: expect.any(String) });

      const describeRes = yield* HttpClient.get(`${workerUrl}/describe`).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((res) => res.json),
      );
      expect(describeRes).toMatchObject({ dimensions: 32 });

      // Mutations are async/eventually consistent — poll the query route
      // until all three upserted vectors are visible.
      const queryBody = yield* HttpClient.get(`${workerUrl}/query`).pipe(
        Effect.flatMap((res) => res.json),
        Effect.map((body) => body as { count: number; ids: string[] }),
        Effect.filterOrFail(
          (body) => body.count >= 3,
          () => ({ _tag: "IndexNotUpdated" }) as const,
        ),
        Effect.retry({
          while: (e) => e._tag === "IndexNotUpdated",
          schedule: Schedule.spaced("3 seconds").pipe(
            Schedule.both(Schedule.recurs(20)),
          ),
        }),
      );
      expect(queryBody.count).toBeGreaterThanOrEqual(3);
      // The query vector equals "a" exactly, so it should be the top match.
      expect(queryBody.ids[0]).toBe("a");

      const getRes = yield* HttpClient.get(`${workerUrl}/get`).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((res) => res.json),
      );
      expect(getRes).toEqual({ ids: ["a", "b"] });

      // Metadata-filtered query: only the vector tagged `kind: "second"`
      // should come back. The metadata index lives on the parent and was
      // created at deploy time before the upsert, so the filter is valid;
      // poll until Cloudflare indexes the upserted vectors with it.
      const filteredBody = yield* HttpClient.get(
        `${workerUrl}/query-filtered`,
      ).pipe(
        Effect.flatMap((res) => res.json),
        Effect.map(
          (body) => body as { count: number; ids: string[]; kinds: string[] },
        ),
      );
      expect(filteredBody.ids).toEqual(["b"]);
      expect(filteredBody.kinds).toEqual(["second"]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);
