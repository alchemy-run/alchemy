import * as Azure from "@alchemy.run/azure";
import { instanceIdOf, STEP_ACTIVITY } from "@alchemy.run/azure/Functions/DurableEngine";
import * as dts from "@distilled.cloud/azure/durabletask-data";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Core from "alchemy/Test/Core";
import type { Status } from "alchemy/Workflows";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { callerObjectId } from "../ConfidentialLedger/util.ts";
import WorkflowCaller from "./fixtures/durable-workflow/caller.ts";
import HostLive, { LOCATION, TestWorkflows } from "./fixtures/durable-workflow/host.ts";

const testOptions = { providers: Azure.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(
  testOptions,
  "AzureWorkflowFunction",
  "test/Azure/Functions/WorkflowFunction.test.ts",
);

/** Deployer credentials and environment for out-of-band reads of the task hub. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

/** The host, the caller, and the deployer's read access to the task hub. */
const stackProgram = Effect.gen(function* () {
  yield* TestWorkflows;
  const caller = yield* WorkflowCaller;
  const { scheduler, taskHub } = yield* TestWorkflows.durableTask;
  // The deployer reads each run's history to see which steps ran.
  const deployer = yield* callerObjectId;
  yield* Azure.Authorization.RoleAssignment("DeployerReadsRuns", {
    scope: taskHub.taskHubId,
    roleDefinitionId: Azure.Authorization.BuiltInRole.DurableTaskDataContributor,
    principalId: deployer,
    principalType: "ServicePrincipal",
  });
  return { url: caller.url, endpoint: scheduler.endpoint, taskHub: taskHub.taskHubName };
});

class NotReady extends Data.TaggedError("NotReady")<{ readonly message: string }> {}

type RunStatus = Status<unknown, unknown>;

/** A fresh id per run, so a retried test never reads an earlier attempt's execution. */
const freshId = (prefix: string) =>
  Effect.sync(() => `${prefix}-${crypto.randomUUID().slice(0, 8)}`);

// Two Flex Consumption apps (billed per execution) and a Consumption Durable
// Task Scheduler (billed per action): ~$0.01/run. The scheduler takes ~3-4
// minutes to provision and ~3 minutes to delete.
describe(
  "Azure WorkflowFunction",
  { tags: ["provider:azure", "provider:azure:functions", "live"] },
  () => {
    let url: string;
    let hub: { endpoint: string; taskHub: string };

    beforeAll(
      Effect.gen(function* () {
        if (!process.env.NO_DESTROY) yield* sharedStack.destroy();
        const outputs = yield* sharedStack.deploy(
          Effect.gen(function* () {
            // Its own group: ARM keeps listing a deleted Durable Task Scheduler
            // for several minutes, which the stack's default group (deleted
            // only once empty) refuses on destroy.
            const group = yield* Azure.Resources.ResourceGroup("WorkflowGroup", {
              location: LOCATION,
            });
            return yield* stackProgram.pipe(
              Effect.provide(HostLive),
              Effect.provide(Azure.resourceGroup(group)),
            );
          }),
        );
        url = outputs.url.replace(/\/$/, "");
        hub = { endpoint: outputs.endpoint, taskHub: outputs.taskHub };
        // Through the Flex Consumption cold start and the caller's task hub
        // role propagation: `/ready` reads a run through the engine.
        yield* request<RunStatus>(`${url}/ready`).pipe(
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 }),
        );
      }),
      { timeout: 1_200_000 },
    );
    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), { timeout: 600_000 });

    const request = <T>(target: string, method: "GET" | "POST" = "GET") =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* method === "POST" ? client.post(target) : client.get(target);
        const body = yield* response.text;
        if (response.status !== 200) {
          return yield* new NotReady({
            message: `${method} ${target}: ${response.status}: ${body}`,
          });
        }
        return (body.startsWith("{") ? JSON.parse(body) : body) as T;
      }).pipe(
        Effect.retry({
          while: (error) => error._tag === "NotReady",
          schedule: Schedule.spaced("2 seconds"),
          times: 5,
        }),
      );

    /** Start a run through the caller, and return how to read it. */
    const start = (workflow: string, id: string, query = "") =>
      Effect.map(
        request<{ executionId: string }>(`${url}/start/${workflow}/${id}${query}`, "POST"),
        ({ executionId }) => ({
          executionId,
          status: request<RunStatus>(`${url}/status/${workflow}/${id}?executionId=${executionId}`),
        }),
      );

    /** Read a run's status until it's finished. */
    const awaitResult = (status: Effect.Effect<RunStatus, unknown, HttpClient.HttpClient>) =>
      status.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (current) => current._tag !== "Running" && current._tag !== "NotStarted",
          times: 60,
        }),
      );

    /** The orchestration instances of a run, from the task hub. */
    const instancesOf = (workflow: string, executionId: string) =>
      dts
        .QueryOrchestrations({
          ...hub,
          filter: { orchestrationId: { value: instanceIdOf(workflow, executionId) } },
        })
        .pipe(
          Effect.map((page) => page.orchestrations ?? []),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (instances) => instances.length > 0,
            times: 20,
          }),
          Effect.provide(azure),
        );

    /** The steps a run recorded, in order, from its history. */
    const stepsOf = (workflow: string, executionId: string) =>
      Effect.gen(function* () {
        const [instance] = yield* instancesOf(workflow, executionId);
        const { history } = yield* dts.GetOrchestrationHistory({
          ...hub,
          instanceId: instance!.instanceId!,
          executionId: instance!.executionId!,
        });
        // A scheduled activity's input is its argument list: `[{ name, exit }]`.
        return (history ?? [])
          .flatMap((event) =>
            event.taskScheduled?.name === STEP_ACTIVITY && event.taskScheduled.input
              ? (JSON.parse(event.taskScheduled.input) as Array<{ name: string }>).map(
                  (step) => step.name,
                )
              : [],
          )
          .map((name) => name.replace(/\/\d+$/, ""));
      }).pipe(Effect.provide(azure));

    test.provider(
      "runs a workflow and returns its result",
      (_stack) =>
        Effect.gen(function* () {
          const id = yield* freshId("greet");
          const run = yield* start("Greet", id, "?name=sam");
          expect(yield* awaitResult(run.status)).toEqual({
            _tag: "Completed",
            result: "hello sam",
          });
          expect(yield* stepsOf("Greet", run.executionId)).toEqual(["greet", "log"]);
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "starting the same execution twice runs it once",
      (_stack) =>
        Effect.gen(function* () {
          const id = yield* freshId("twice");
          const first = yield* start("Greet", id);
          const second = yield* start("Greet", id);
          expect(second.executionId).toBe(first.executionId);
          expect(yield* awaitResult(first.status)).toEqual({
            _tag: "Completed",
            result: "hello world",
          });
          expect((yield* instancesOf("Greet", first.executionId)).length).toBe(1);
          expect(yield* stepsOf("Greet", first.executionId)).toEqual(["greet", "log"]);
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "sleeps durably between steps",
      (_stack) =>
        Effect.gen(function* () {
          const id = yield* freshId("nap");
          const run = yield* start("Nap", id, "?seconds=3");
          expect(yield* awaitResult(run.status)).toEqual({ _tag: "Completed", result: "rested" });
          expect(yield* stepsOf("Nap", run.executionId)).toEqual(["before", "after"]);
          const [instance] = yield* instancesOf("Nap", run.executionId);
          const { history } = yield* dts
            .GetOrchestrationHistory({
              ...hub,
              instanceId: instance!.instanceId!,
              executionId: instance!.executionId!,
            })
            .pipe(Effect.provide(azure));
          expect((history ?? []).filter((event) => event.timerFired !== undefined).length).toBe(1);
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "waits for a signal from outside",
      (_stack) =>
        Effect.gen(function* () {
          const id = yield* freshId("approve");
          const run = yield* start("Approve", id);
          yield* request(
            `${url}/approve/Approve/${id}?executionId=${run.executionId}&by=agent`,
            "POST",
          );
          expect(yield* awaitResult(run.status)).toEqual({
            _tag: "Completed",
            result: "approved by agent",
          });
          expect(yield* stepsOf("Approve", run.executionId)).toEqual(["requested", "approved"]);
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "a typed failure runs compensations",
      (_stack) =>
        Effect.gen(function* () {
          const id = yield* freshId("declined");
          const run = yield* start("Checkout", id, "?decline=true");
          expect(yield* awaitResult(run.status)).toEqual({
            _tag: "Failed",
            error: { _tag: "Declined", reason: "card declined" },
          });
          expect(yield* stepsOf("Checkout", run.executionId)).toEqual([
            "reserve",
            "charge",
            "release",
          ]);
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "a successful workflow keeps its steps",
      (_stack) =>
        Effect.gen(function* () {
          const id = yield* freshId("charged");
          const run = yield* start("Checkout", id);
          expect(yield* awaitResult(run.status)).toEqual({ _tag: "Completed", result: "charged" });
          expect(yield* stepsOf("Checkout", run.executionId)).toEqual(["reserve", "charge"]);
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "interrupting a waiting workflow finishes it",
      (_stack) =>
        Effect.gen(function* () {
          const id = yield* freshId("interrupt");
          const run = yield* start("Approve", id);
          // Interrupt once it's waiting on its signal.
          yield* stepsOf("Approve", run.executionId).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (steps) => steps.includes("requested"),
              times: 45,
            }),
          );
          yield* request(`${url}/interrupt/Approve/${id}?executionId=${run.executionId}`, "POST");
          expect(yield* awaitResult(run.status)).toEqual({ _tag: "Interrupted" });
          expect(yield* stepsOf("Approve", run.executionId)).toEqual(["requested"]);
          // Woken by the interrupt event and finished by itself, not terminated.
          const [instance] = yield* instancesOf("Approve", run.executionId);
          expect(instance!.orchestrationStatus).toBe("ORCHESTRATION_STATUS_COMPLETED");
        }),
      { timeout: 240_000 },
    );

    test.provider(
      "runs a child workflow",
      (_stack) =>
        Effect.gen(function* () {
          const id = yield* freshId("parent");
          const run = yield* start("Parent", id);
          expect(yield* awaitResult(run.status)).toEqual({
            _tag: "Completed",
            result: "parent got hello child",
          });
          expect(yield* stepsOf("Parent", run.executionId)).toEqual(["parent"]);
        }),
      { timeout: 240_000 },
    );
  },
);
