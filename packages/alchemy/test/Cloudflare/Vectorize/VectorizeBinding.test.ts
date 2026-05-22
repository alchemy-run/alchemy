import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import VectorizeWorker from "./fixtures/vectorize-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {}

/**
 * End-to-end test of `Cloudflare.VectorizeConnection.bind(...)` against a
 * real Cloudflare Worker + Vectorize index.
 *
 * The worker exercises the client surface (`upsert`, `describe`, `query`,
 * `getByIds`). Vectorize mutations are eventually consistent, so after
 * upserting we retry the query/get routes until the vectors are visible.
 */
test.provider(
  "VectorizeConnection.bind exercises the client surface",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* VectorizeWorker;
        }),
      );

      expect(worker.url).toBeTypeOf("string");
      const baseUrl = worker.url as string;

      // Fresh workers.dev URLs take a few seconds to start serving 200s.
      // Retry the upsert until the route handler responds.
      const upsertRes = yield* HttpClient.execute(
        HttpClientRequest.post(`${baseUrl}/upsert`),
      ).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? Effect.succeed(res)
            : res.text.pipe(
                Effect.flatMap((body) =>
                  Effect.fail(new WorkerNotReady({ status: res.status, body })),
                ),
              ),
        ),
        Effect.retry({
          while: (e): e is WorkerNotReady =>
            e instanceof WorkerNotReady && e.status >= 400 && e.status < 600,
          schedule: Schedule.exponential("500 millis").pipe(
            Schedule.both(Schedule.recurs(20)),
          ),
        }),
      );
      expect(upsertRes.status).toBe(200);

      const describeRes = yield* HttpClient.get(`${baseUrl}/describe`);
      expect(describeRes.status).toBe(200);
      expect(yield* describeRes.json).toMatchObject({ dimensions: 3 });

      // Mutations are async/eventually consistent — poll the query route
      // until all three upserted vectors are visible.
      const queryBody = yield* HttpClient.get(`${baseUrl}/query`).pipe(
        Effect.flatMap((res) => res.json),
        Effect.map((body) => body as { count: number; ids: string[] }),
        Effect.filterOrFail(
          (body) => body.count >= 3,
          () => new WorkerNotReady({ status: 200, body: "not indexed yet" }),
        ),
        Effect.retry({
          schedule: Schedule.spaced("3 seconds").pipe(
            Schedule.both(Schedule.recurs(20)),
          ),
        }),
      );
      expect(queryBody.count).toBeGreaterThanOrEqual(3);
      // The query vector equals "a" exactly, so it should be the top match.
      expect(queryBody.ids[0]).toBe("a");

      const getRes = yield* HttpClient.get(`${baseUrl}/get`);
      expect(getRes.status).toBe(200);
      expect(yield* getRes.json).toEqual({ ids: ["a", "b"] });

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);
