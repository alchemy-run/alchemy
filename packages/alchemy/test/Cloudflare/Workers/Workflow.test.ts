import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import WorkflowTestWorker from "./fixtures/workflow-worker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const Stack = Alchemy.Stack(
  "WorkflowBindingStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* WorkflowTestWorker;
    return {
      url: worker.url.as<string>(),
    };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "deployed worker can run a workflow to completion",
  Effect.gen(function* () {
    const out = yield* stack;
    const url = out.url;
    expect(url).toBeTypeOf("string");

    const client = yield* HttpClient.HttpClient;

    // Cloudflare's edge takes a few seconds to start serving a fresh
    // workers.dev URL, so retry the initial start call until it returns 200.
    const startRes = yield* client.post(`${url}/workflow/start/world`).pipe(
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 10,
      }),
    );
    expect(startRes.status).toBe(200);
    const { instanceId } = (yield* startRes.json) as { instanceId: string };
    expect(instanceId).toBeTypeOf("string");

    // Poll the workflow status until it reaches a terminal state.
    let lastStatus:
      | {
          status: string;
          output?: { greeting: string; envBindingCount: number };
          error?: { message?: string } | null;
        }
      | undefined;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const statusRes = yield* client.get(
        `${url}/workflow/status/${instanceId}`,
      );
      lastStatus = (yield* statusRes.json) as typeof lastStatus;
      if (
        lastStatus?.status === "complete" ||
        lastStatus?.status === "errored"
      ) {
        break;
      }
      yield* Effect.sleep("2 seconds");
    }

    expect(lastStatus).toBeDefined();
    expect(lastStatus!.status).toBe("complete");
    expect(lastStatus!.error).toBeFalsy();
    expect(lastStatus!.output?.greeting).toBe("Hello, world!");
    // The body yields `WorkerEnvironment` — if the regression from PR #71 ever
    // returns, the body dies on the first yield and `output` is undefined.
    expect(lastStatus!.output?.envBindingCount).toBeGreaterThan(0);
  }).pipe(logLevel),
  { timeout: 180_000 },
);
