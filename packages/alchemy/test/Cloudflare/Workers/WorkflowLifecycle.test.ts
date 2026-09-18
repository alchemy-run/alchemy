import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
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
  const client = yield* HttpClient.HttpClient;
  const response = yield* method === "GET" ? client.get(url) : client.post(url);
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
        const status = yield* request(`${url}/status/${id}`).pipe(
          Effect.flatMap((body) =>
            Effect.try(() => JSON.parse(body) as Status),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            times: 10,
            until: (status) =>
              (status.status === "complete" || status.status === "errored") &&
              (scenario !== "rollback" ||
                (status.entries.includes("rollback-body") &&
                  status.entries.includes("rollback-close"))),
          }),
        );
        expect(status, JSON.stringify(status)).toMatchObject({
          status: scenario === "rollback" ? "errored" : "complete",
          entries,
        });
        if (scenario !== "rollback") expect(status.output).toEqual(entries);
      }),
      { timeout: 60_000 },
    );
  }
});
