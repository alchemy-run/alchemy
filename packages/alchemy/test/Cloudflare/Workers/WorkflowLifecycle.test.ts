import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import LifecycleWorker, {
  type Scenario,
} from "./fixtures/workflow-lifecycle/worker.ts";

const Stack = Alchemy.Stack(
  "WorkflowLifecycleStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* LifecycleWorker;
    return { url: worker.url.as<string>() };
  }),
);

interface Status {
  status: string;
  output?: string[];
  error?: unknown;
  rollback?: { outcome: string } | null;
  entries: string[];
}

const request = Effect.fn(function* (
  url: string,
  method: "GET" | "POST" = "GET",
) {
  const response = yield* requestWorker(
    method === "GET" ? HttpClientRequest.get(url) : HttpClientRequest.post(url),
  );
  const body = yield* response.text;
  if (response.status !== 200) {
    return yield* Effect.fail(
      new Error(`${method} ${url}: ${response.status}: ${body}`),
    );
  }
  return body;
});

const cases: Array<{ scenario: Scenario; entries: string[] }> = [
  {
    scenario: "success",
    entries: ["open:1:captured:true", "close:1", "after-task"],
  },
  {
    scenario: "retry",
    entries: [
      "open:1:captured:true",
      "close:1",
      "open:2:captured:true",
      "close:2",
      "after-task",
    ],
  },
  {
    scenario: "interrupt",
    entries: ["open:1:captured:true", "close:1", "joined", "after-task"],
  },
  {
    scenario: "rollback",
    entries: [
      "open:1:captured:true",
      "close:1",
      "after-task",
      "rollback-open:captured:true",
      "rollback-body",
      "rollback-close",
    ],
  },
];

describe.concurrent.each([
  { dev: true, stage: "workflow-lifecycle-local" },
  { dev: false, stage: "workflow-lifecycle-live" },
])("Workflow lifecycle (dev: $dev)", ({ dev, stage }) => {
  const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
    dev,
    stage,
  });
  const stack = beforeAll(
    Effect.gen(function* () {
      yield* destroy(Stack);
      const output = yield* deploy(Stack);
      yield* request(`${output.url}/ready`).pipe(
        Effect.retry({ schedule: Schedule.spaced("1 second"), times: 8 }),
      );
      return output;
    }),
    { timeout: 120_000 },
  );
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
    timeout: 30_000,
  });

  for (const { scenario, entries } of cases) {
    test(
      `closes and owns ${scenario} attempt resources`,
      Effect.gen(function* () {
        const { url } = yield* stack;
        const started = yield* request(`${url}/start/${scenario}`, "POST");
        const { id } = yield* Effect.try(
          () => JSON.parse(started) as { id: string },
        );
        if (scenario === "rollback") {
          // Native status() can reject during compensation; observe cleanup first.
          const journal = yield* request(`${url}/journal/${id}`).pipe(
            Effect.flatMap((body) =>
              Effect.try(() => JSON.parse(body) as string[]),
            ),
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              times: 10,
              until: (entries) => entries.includes("rollback-close"),
            }),
          );
          expect(journal).toEqual(entries);
        }
        const status = yield* request(`${url}/status/${id}`).pipe(
          Effect.flatMap((body) =>
            Effect.try(() => JSON.parse(body) as Status),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            times: 10,
            until: (status) =>
              status.status === "complete" || status.status === "errored",
          }),
        );
        expect(status, JSON.stringify(status)).toMatchObject({
          status: scenario === "rollback" ? "errored" : "complete",
          entries,
        });
        if (scenario === "rollback") {
          if (!dev) {
            expect(status.rollback).toMatchObject({ outcome: "complete" });
          }
          expect(status.error).toMatchObject({
            message: "trigger compensation",
          });
        } else {
          expect(status.output).toEqual(entries);
        }
      }),
      { timeout: 60_000 },
    );
  }
});
