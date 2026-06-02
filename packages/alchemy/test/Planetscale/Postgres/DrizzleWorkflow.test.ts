import * as Cloudflare from "@/Cloudflare";
import * as Planetscale from "@/Planetscale";
import * as Test from "@/Test/Vitest";
import { describe, expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import DrizzleWorkflowWorker from "./fixtures/drizzle-workflow-worker.ts";
import { Hyperdrive, PlanetscaleDb } from "./fixtures/drizzle-workflow-db.ts";
import type { Widget } from "./fixtures/schema.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Planetscale.providers()),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

interface WorkflowStatus {
  status: string;
  output?: {
    inserted: Widget;
    rowCount: number;
    widget: Widget | null;
  };
  error?: { message?: string } | null;
}

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

describe.skipIf(!process.env.PLANETSCALE_TEST)(() => {
  /**
   * End-to-end regression guard for the ExecutionContext-in-Workflow fix
   * (PR #515): deploy a Planetscale Postgres + branch + role, point a
   * Cloudflare Hyperdrive at it, host a Workflow that runs `Drizzle.postgres`
   * queries inside `task` steps, fire an instance over HTTP, and assert the
   * run completes with the row it wrote.
   *
   * Before the fix the query inside the step dies on a missing
   * `ExecutionContext` service and the run reports `errored` with no output.
   */
  test.provider(
    "Drizzle.postgres query runs inside a Workflow task (ExecutionContext provided per run)",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const { worker } = yield* stack.deploy(
          Effect.gen(function* () {
            yield* PlanetscaleDb;
            yield* Hyperdrive;
            const worker = yield* DrizzleWorkflowWorker;
            return { worker };
          }),
        );

        expect(worker.url).toBeTypeOf("string");
        const baseUrl = (worker.url as string).replace(/\/+$/, "");
        const client = yield* HttpClient.HttpClient;

        const runToCompletion = Effect.gen(function* () {
          // Fresh workers.dev edge takes a few seconds to start serving 200s.
          const startRes = yield* client
            .post(`${baseUrl}/workflow/start/1`)
            .pipe(
              Effect.flatMap((res) =>
                res.status === 200
                  ? Effect.succeed(res)
                  : Effect.fail(new WorkerNotReady({ status: res.status })),
              ),
              Effect.retry({
                while: (e): e is WorkerNotReady =>
                  e instanceof WorkerNotReady &&
                  e.status >= 400 &&
                  e.status < 600,
                schedule: Schedule.exponential("500 millis").pipe(
                  Schedule.both(Schedule.recurs(15)),
                ),
              }),
            );
          const { instanceId } = (yield* startRes.json) as {
            instanceId: string;
          };
          expect(instanceId).toBeTypeOf("string");

          const last = yield* client
            .get(`${baseUrl}/workflow/status/${instanceId}`)
            .pipe(
              Effect.flatMap((res) =>
                res.status === 200
                  ? Effect.succeed(res)
                  : Effect.fail(new WorkerNotReady({ status: res.status })),
              ),
              Effect.flatMap((res) => res.json),
              Effect.map((json) => json as unknown as WorkflowStatus),
              Effect.repeat({
                schedule: Schedule.spaced("2 seconds"),
                until: (s) => s.status === "complete" || s.status === "errored",
                times: 30,
              }),
            );
          if (last.status !== "complete") {
            return yield* Effect.fail(
              new Error(
                `workflow ${last.status}: ${JSON.stringify(last.error)}`,
              ),
            );
          }
          return last;
        });

        const last = yield* runToCompletion.pipe(
          Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 2 }),
        );

        expect(last.status).toBe("complete");
        expect(last.error).toBeFalsy();
        expect(last.output?.rowCount).toBe(1);
        expect(last.output?.widget).toMatchObject({ id: 1, name: "widget-1" });
        expect(last.output?.inserted).toMatchObject({
          id: 1,
          name: "widget-1",
        });

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 600_000 },
  );
});
