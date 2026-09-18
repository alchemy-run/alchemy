import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as State from "@/State/State";
import * as Test from "@/Test/Alchemy";
import * as workflows from "@distilled.cloud/cloudflare/workflows";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import WorkflowLocalWorker from "./fixtures/workflow-worker.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command (see
// MakeOptions.sidecar in Test/Core.ts).
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

class WorkflowLinkNotReady extends Data.TaggedError("WorkflowLinkNotReady")<{
  instanceId: string;
}> {}

interface WorkflowStatus {
  status: string;
  output?: {
    greeting: string;
    retryAttempt: number;
    retryConfig: Cloudflare.Workflows.WorkflowStepConfig;
    timeoutConfig: Cloudflare.Workflows.WorkflowStepConfig;
    defaultsOk: boolean;
    workflowName: string;
    instanceId: string;
  };
  error?: { message?: string } | null;
  rollback?: {
    outcome: "complete" | "failed";
    error: { message?: string } | null;
  } | null;
}

const isTerminal = (status: WorkflowStatus): boolean =>
  status.status === "complete" ||
  status.status === "errored" ||
  status.status === "terminated";

/**
 * Start a workflow instance over HTTP, retrying while the freshly-served
 * worker is still coming up (local workerd boots fast; a fresh workers.dev
 * URL takes a few seconds to start serving 200s).
 */
const startInstance = (url: string, path = "/workflow/start/world") =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.post(`${url}${path}`).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new WorkerNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e) => e._tag === "WorkerNotReady" && e.status === 404,
        schedule: Schedule.spaced("2 seconds"),
        times: 10,
      }),
    );
    const { instanceId } = (yield* res.json) as { instanceId: string };
    expect(instanceId).toBeTypeOf("string");
    return instanceId;
  });

/** Poll one instance without retrying failed workflow executions. */
const waitForTerminal = (url: string, instanceId: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(`${url}/workflow/status/${instanceId}`).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? res.json.pipe(
              Effect.map((json) => json as unknown as WorkflowStatus),
            )
          : res.text.pipe(
              Effect.flatMap((body) =>
                Effect.fail(
                  new Error(`Workflow status ${res.status}: ${body}`),
                ),
              ),
            ),
      ),
      Effect.repeat({
        schedule: Schedule.spaced("3 seconds"),
        until: isTerminal,
        times: 10,
      }),
    );
  });

const runInstance = (url: string, path: string, live = false) =>
  Effect.gen(function* () {
    const instanceId = yield* startInstance(url, path);
    const status = yield* waitForTerminal(url, instanceId);
    // A newly deployed live workflow can precede its worker/engine link.
    if (
      live &&
      status.status === "errored" &&
      status.error?.message === "Worker not found."
    ) {
      return yield* Effect.fail(new WorkflowLinkNotReady({ instanceId }));
    }
    return { instanceId, status };
  }).pipe(
    Effect.retry({
      while: (error) => error instanceof WorkflowLinkNotReady,
      schedule: Schedule.spaced("3 seconds"),
      times: 2,
    }),
  );

const assertRollback = (url: string, live = false) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const { instanceId, status } = yield* runInstance(
      url,
      "/workflow/rollback",
      live,
    );
    expect(status).toMatchObject({ status: "errored" });
    expect(status.error?.message).toContain("rollback requested");
    // Local bindings omit rollback metadata; the persisted records verify execution.
    if (live) {
      expect(status.rollback).toEqual({ outcome: "complete", error: null });
    }

    const response = yield* client.get(
      `${url}/workflow/rollback-result/${instanceId}`,
    );
    expect(response.status).toBe(200);
    expect(yield* response.json).toEqual(
      ["undefined", "both", "timeout-only", "retries-only"].map((step) => ({
        output: { value: "reserved", step },
        error: "rollback requested",
      })),
    );
  });

const assertFailureScenarios = (url: string, live = false) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    for (const scenario of [
      "timeout-zero",
      "rollback-timeout-zero",
      "retry-exhaustion",
      "rollback-retry-exhaustion",
    ]) {
      const { instanceId, status } = yield* runInstance(
        url,
        `/workflow/scenario/${scenario}`,
        live,
      );
      const zeroTimeout = scenario.endsWith("timeout-zero");
      const response = yield* client.get(
        `${url}/workflow/record/${instanceId}/${zeroTimeout ? "protected" : "attempts"}`,
      );
      expect(response.status).toBe(200);
      const record = yield* response.json;
      yield* Effect.log("Workflow failure scenario", {
        scenario,
        status,
        record,
      });
      expect(status).toMatchObject({ status: "errored" });
      if (zeroTimeout) {
        if (live && scenario === "rollback-timeout-zero") {
          // Cloudflare validates rollback config on execution, without exposing its error.
          expect(status.error?.message).toBe("rollback requested");
          expect(status.rollback).toEqual({ outcome: "failed", error: null });
        } else {
          expect(status.error?.message).toContain("invalid format");
        }
        expect(record).toBeNull();
      } else {
        expect(status.error?.message).toContain(
          scenario === "retry-exhaustion"
            ? "retry budget exhausted"
            : "rollback requested",
        );
        expect(record).toEqual({ attempt: 2 });
        if (live && scenario === "rollback-retry-exhaustion") {
          expect(status.rollback?.outcome).toBe("failed");
          expect(status.rollback?.error?.message).toContain(
            "rollback budget exhausted",
          );
        }
      }
    }
  });

/**
 * Read the persisted state row of the nested `Cloudflare.Workflow` resource
 * (the WorkflowResource the `Workflow` effect-class registers under the host
 * worker) from the scratch stack's private state store.
 */
const readWorkflowRow = (stack: Test.ScratchStack) =>
  Effect.gen(function* () {
    const state = yield* yield* State.State;
    const fqns = yield* state.list({ stack: stack.name, stage: stack.stage });
    for (const fqn of fqns) {
      const row = yield* state.get({
        stack: stack.name,
        stage: stack.stage,
        fqn,
      });
      if (
        row &&
        (row as { resourceType?: string }).resourceType ===
          "Cloudflare.Workflow"
      ) {
        return row as {
          resourceType: string;
          providerMode?: "live" | "local";
          attr?: {
            workflowId: string;
            workflowName: string;
            accountId: string;
          };
        };
      }
    }
    return undefined;
  }).pipe(Effect.provide(stack.state));

/**
 * Under `alchemy dev` the Workflow resource is emulated by the local provider
 * (a `dev:` id, no cloud API calls) and the host worker's `workflow` binding
 * is lowered onto the local workerd workflow engine. This exercises the full
 * local roundtrip: create an instance through the binding and poll it to
 * completion against the local simulator.
 */
test.provider(
  "workflow runs to completion against the local simulator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* WorkflowLocalWorker;
          return { worker };
        }),
      );

      // The worker serves from the local dev proxy — proof the stack ran in
      // local mode.
      expect(deployed.worker.url).toMatch(/^http:\/\/localhost:\d+$/);

      // The local provider fabricated a `dev:` workflow id (proof no cloud
      // call ran) and the row is stamped with the local provider mode.
      const row = yield* readWorkflowRow(stack);
      expect(row).toBeDefined();
      expect(row!.attr?.workflowId).toMatch(/^dev:/);
      expect(row!.providerMode).toBe("local");

      // Drive the workflow through the binding against local workerd.
      const url = deployed.worker.url!;
      const instanceId = yield* startInstance(url);
      const status = yield* waitForTerminal(url, instanceId);

      expect(status).toMatchObject({ status: "complete" });
      expect(status.output?.greeting).toBe("Hello, world!");
      expect(status.output?.instanceId).toBe(instanceId);

      expect(status.error).toBeFalsy();
      expect(status.output?.retryAttempt).toBe(2);
      expect(status.output?.retryConfig.retries).toEqual({
        limit: 2,
        delay: "1 second",
        backoff: "constant",
      });
      expect(status.output?.retryConfig.timeout).toBeDefined();
      expect(status.output?.timeoutConfig.timeout).toBe("30 seconds");
      expect(status.output?.timeoutConfig.retries).toBeDefined();
      expect(status.output?.defaultsOk).toBe(true);
      yield* Effect.log("Workflow resolved configuration", status.output);
      yield* assertRollback(url);
      yield* assertFailureScenarios(url);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

/**
 * `Alchemy.remote()` opts the whole worker + hosted workflow OUT of local
 * emulation: even under `alchemy dev` the worker deploys to real Cloudflare
 * and `putWorkflow` registers a real account-level Workflow. The workflow
 * class is hosted BY the worker script, so both must run live together —
 * a live workflow cannot reference a script that only exists in local
 * workerd. After destroy, an out-of-band `getWorkflow` proves the cloud
 * workflow is gone (pins the stamped-mode delete path).
 */
test.provider(
  "Alchemy.remote() worker + workflow run live in dev and delete on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* WorkflowLocalWorker;
          return { worker };
        }).pipe(Alchemy.remote()),
      );

      // Live deploy: a real workers.dev URL, not the local dev proxy.
      expect(deployed.worker.url).not.toMatch(/^http:\/\/localhost/);

      // The workflow has a real Cloudflare id and a `live` mode stamp.
      const row = yield* readWorkflowRow(stack);
      expect(row).toBeDefined();
      expect(row!.attr?.workflowId).not.toMatch(/^dev:/);
      expect(row!.providerMode).toBe("live");
      const workflowName = row!.attr!.workflowName;
      const workflowAccountId = row!.attr!.accountId;

      // Out-of-band: the workflow exists on real Cloudflare.
      const live = yield* workflows.getWorkflow({
        accountId: workflowAccountId,
        workflowName,
      });
      expect(live.id).toBe(row!.attr!.workflowId);

      const url = deployed.worker.url!;
      const { status } = yield* runInstance(url, "/workflow/start/world", true);
      expect(status).toMatchObject({ status: "complete" });
      expect(status.error).toBeFalsy();
      expect(status.output?.greeting).toBe("Hello, world!");
      expect(status.output?.retryAttempt).toBe(2);
      expect(status.output?.retryConfig.retries).toEqual({
        limit: 2,
        delay: "1 second",
        backoff: "constant",
      });
      expect(status.output?.retryConfig.timeout).toBeDefined();
      expect(status.output?.timeoutConfig.timeout).toBe("30 seconds");
      expect(status.output?.timeoutConfig.retries).toBeDefined();
      expect(status.output?.defaultsOk).toBe(true);
      yield* Effect.log("Workflow resolved configuration", status.output);
      yield* assertRollback(url, true);
      yield* assertFailureScenarios(url, true);

      yield* stack.destroy();

      // The live-stamped row was deleted through the live provider even in a
      // dev run — the cloud workflow is gone.
      const gone = yield* workflows
        .getWorkflow({ accountId: workflowAccountId, workflowName })
        .pipe(
          Effect.as(false),
          Effect.catchTag("WorkflowNotFound", () => Effect.succeed(true)),
        );
      expect(gone).toBe(true);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
