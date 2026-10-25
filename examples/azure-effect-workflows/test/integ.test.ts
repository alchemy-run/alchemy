import { expect } from "bun:test";
import * as Azure from "@alchemy.run/azure";
import * as durabletask from "@distilled.cloud/azure/durabletask";
import * as web from "@distilled.cloud/azure/web";
import * as Alchemy from "alchemy";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Bun";
import type { Status } from "alchemy/Workflows";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

/** The deployer's credentials, for out-of-band ARM reads. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

// Two Flex Consumption apps (billed per execution) and a Consumption Durable
// Task Scheduler (billed per action): a few cents per run. The scheduler takes
// about 3 minutes to create and to delete.
const stack = beforeAll(deploy(Stack), { timeout: 1_200_000 });

class NotOk extends Data.TaggedError("NotOk")<{ readonly status: number; readonly body: string }> {}

type RunStatus = Status<string, { _tag: "Declined"; reason: string }>;

const call = <T>(method: "GET" | "POST", path: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const target = `${String(url).replace(/\/+$/, "")}${path}`;
    const res = yield* method === "POST" ? client.post(target) : client.get(target);
    const body = yield* res.text;
    if (res.status >= 300) return yield* new NotOk({ status: res.status, body });
    return (body.startsWith("{") ? JSON.parse(body) : body) as T;
  }).pipe(
    // The Flex Consumption cold start, and the API's task hub role
    // propagating after the first deploy, take a few minutes.
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 }),
  );

const awaitDone = (executionId: string) =>
  call<RunStatus>("GET", `/runs/${executionId}`).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status._tag !== "Running" && status._tag !== "NotStarted",
      times: 60,
    }),
  );

const orderId = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

/** Where the example's resources are, from the stack outputs. */
const where = Effect.gen(function* () {
  const outputs = yield* stack;
  const { subscriptionId } = yield* Azure.AzureEnvironment.current.pipe(Effect.provide(azure));
  return {
    subscriptionId,
    resourceGroupName: outputs.resourceGroup,
    schedulerName: outputs.scheduler,
    taskHubName: outputs.taskHub,
    name: outputs.workflowsApp,
  };
});

type Where = Effect.Success<typeof where>;

const taskHubStatus = (ids: Where) =>
  durabletask
    .GetTaskHub({
      subscriptionId: ids.subscriptionId,
      resourceGroupName: ids.resourceGroupName,
      schedulerName: ids.schedulerName,
      taskHubName: ids.taskHubName,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
        Effect.succeed("gone" as const),
      ),
      Effect.provide(azure),
    );

const workflowsAppStatus = (ids: Where) =>
  web
    .GetWebApp({
      subscriptionId: ids.subscriptionId,
      resourceGroupName: ids.resourceGroupName,
      name: ids.name,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
        Effect.succeed("gone" as const),
      ),
      Effect.provide(azure),
    );

/** Poll until a deleted resource reads as gone. */
const untilGone = <E, R>(status: Effect.Effect<"found" | "gone", E, R>) =>
  status.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (current) => current === "gone",
      times: 24,
    }),
  );

afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const ids = yield* where;
    yield* destroy(Stack);
    expect(yield* untilGone(taskHubStatus(ids))).toBe("gone");
    expect(yield* untilGone(workflowsAppStatus(ids))).toBe("gone");
  }),
  // Destroy waits for ARM to stop listing the deleted scheduler (up to ~15 minutes).
  { timeout: 1_800_000 },
);

test(
  "the workflow function and its task hub exist",
  Effect.gen(function* () {
    const ids = yield* where;
    expect(yield* taskHubStatus(ids)).toBe("found");
    expect(yield* workflowsAppStatus(ids)).toBe("found");
  }),
  { timeout: 120_000 },
);

test(
  "an approved order is charged",
  Effect.gen(function* () {
    const { executionId } = yield* call<{ executionId: string }>(
      "POST",
      `/orders/${orderId("ok")}?quantity=2`,
    );
    yield* call("POST", `/runs/${executionId}/approve?by=alice`);
    const status = yield* awaitDone(executionId);
    expect(status._tag).toBe("Completed");
    expect(status._tag === "Completed" ? status.result : "").toContain("approved by alice");
  }),
  { timeout: 600_000 },
);

test(
  "an order over the limit is declined",
  Effect.gen(function* () {
    const { executionId } = yield* call<{ executionId: string }>(
      "POST",
      `/orders/${orderId("big")}?quantity=9`,
    );
    yield* call("POST", `/runs/${executionId}/approve?by=bob`);
    expect(yield* awaitDone(executionId)).toEqual({
      _tag: "Failed",
      error: { _tag: "Declined", reason: "9 is over the limit of 5" },
    });
  }),
  { timeout: 600_000 },
);

test(
  "a cancelled order is interrupted",
  Effect.gen(function* () {
    const { executionId } = yield* call<{ executionId: string }>(
      "POST",
      `/orders/${orderId("cancel")}?quantity=1`,
    );
    yield* call("POST", `/runs/${executionId}/cancel`);
    expect(yield* awaitDone(executionId)).toEqual({ _tag: "Interrupted" });
  }),
  { timeout: 600_000 },
);
