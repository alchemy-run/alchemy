/**
 * A Workflow bound on an async Worker's `env` exposes its physical name on
 * `worker.env.<binding>.workflowName` as an Output of the current deploy. A
 * Queue subscription declared in the same stack must receive the resolved
 * name on the Workflow's FIRST deployment and deploy after the Workflow is
 * registered — without the stack re-deriving the name or reading persisted
 * state.
 *
 * Runs against stub providers for the three resource types involved: the
 * assertions are about the engine wiring (Outputs, dependencies, ordering)
 * and the name staying in sync with the uploaded `workflow` binding, not
 * about the Cloudflare API.
 */
import * as Cloudflare from "@/Cloudflare/index.ts";
import type { WorkerBinding } from "@/Cloudflare/Workers/WorkerBinding.ts";
import * as Output from "@/Output.ts";
import * as Provider from "@/Provider.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

type WorkflowWireBinding = Extract<WorkerBinding, { type: "workflow" }>;

/** Reconcile order and the `workflow` wire bindings each Worker uploaded. */
const observed: {
  order: string[];
  uploaded: Record<string, WorkflowWireBinding | undefined>;
} = { order: [], uploaded: {} };

const reset = () => {
  observed.order = [];
  observed.uploaded = {};
};

const workerAttributes = (id: string) =>
  ({
    workerId: `id-${id}`,
    workerName: `stub-${id.toLowerCase()}`,
    namespace: undefined,
    logpush: undefined,
    url: undefined,
    urls: [],
    domain: undefined,
    tags: undefined,
    durableObjectNamespaces: {},
    accountId: "stub-account",
    routes: [],
    crons: [],
  }) satisfies Cloudflare.Worker["Attributes"];

// Registered through `Provider.effect` like the real Worker provider: the
// Worker is a Platform, which `Provider.succeed`'s class parameter rejects.
const workerStub = Provider.effect(
  Cloudflare.Worker,
  Effect.succeed({
    list: () => Effect.succeed([]),
    diff: Effect.fn(function* () {
      return undefined;
    }),
    // The Worker's own `workflow` binding derives from its `workerName`, so
    // the real provider publishes the name from `precreate`; mirror that.
    precreate: Effect.fn(function* ({ id }) {
      return workerAttributes(id);
    }),
    reconcile: Effect.fn(function* ({ id, bindings }) {
      observed.order.push(`Worker:${id}`);
      observed.uploaded[id] = bindings
        .flatMap((binding) => binding.data.bindings ?? [])
        .find(
          (binding): binding is WorkflowWireBinding =>
            binding.type === "workflow",
        );
      return workerAttributes(id);
    }),
    delete: Effect.fn(function* () {}),
  }),
);

const workflowStub = Provider.succeed(Cloudflare.Workflows.WorkflowResource, {
  list: () => Effect.succeed([]),
  diff: Effect.fn(function* () {
    return undefined;
  }),
  reconcile: Effect.fn(function* ({ id, news }) {
    observed.order.push(`Workflow:${id}`);
    return {
      workflowId: `id-${id}`,
      workflowName: news.workflowName,
      className: news.className,
      scriptName: news.scriptName,
      accountId: "stub-account",
      schedules: news.schedules ?? [],
    };
  }),
  delete: Effect.fn(function* () {}),
});

const subscriptionStub = Provider.succeed(Cloudflare.Queues.Subscription, {
  list: () => Effect.succeed([]),
  diff: Effect.fn(function* () {
    return undefined;
  }),
  reconcile: Effect.fn(function* ({ id, news }) {
    observed.order.push(`Subscription:${id}`);
    return {
      subscriptionId: `id-${id}`,
      accountId: "stub-account",
      name: news.name ?? id,
      source: news.source,
      events: news.events,
      queueId: news.queueId,
      enabled: news.enabled ?? true,
      createdAt: "",
      modifiedAt: "",
    };
  }),
  delete: Effect.fn(function* () {}),
});

const { test } = Test.make({
  providers: Layer.mergeAll(workerStub, workflowStub, subscriptionStub),
});

const script = `export default { fetch: () => new Response("ok") };`;

const workflowNameOf = (
  source: Cloudflare.Queues.SubscriptionAttributes["source"],
) => (source.type === "workflows.workflow" ? source.workflowName : undefined);

test.provider(
  "a same-stack Queue subscription receives the Workflow's name on first deploy",
  (stack) =>
    Effect.gen(function* () {
      reset();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* Cloudflare.Worker("WorkflowHost", {
            script,
            env: {
              FILE_URL_INGESTION: Cloudflare.Workflow("FileUrlIngestion", {
                className: "FileUrlIngestionWorkflow",
              }),
            },
          });
          const binding = worker.env.FILE_URL_INGESTION;
          const subscription = yield* Cloudflare.Queues.Subscription(
            "WorkflowEvents",
            {
              source: {
                type: "workflows.workflow",
                workflowName: binding.workflowName,
              },
              events: ["instance.completed", "instance.errored"],
              queueId: "stub-queue",
            },
          );
          return {
            worker,
            subscription,
            // Snapshot of the binding as the stack saw it at declaration
            // time; the Outputs resolve with the rest of the stack output.
            binding: {
              kind: binding.kind,
              name: binding.name,
              className: binding.className,
              isOutput: Output.isOutput(binding.workflowName),
              workflowName: binding.workflowName,
              scriptName: binding.scriptName,
            },
          };
        }),
      );

      // Declared as an Output, resolved by the deploy to the physical name.
      expect(deployed.binding.isOutput).toBe(true);
      expect(deployed.binding.kind).toBe("Cloudflare.Workflow");
      expect(deployed.binding.name).toBe("FileUrlIngestion");
      expect(deployed.binding.className).toBe("FileUrlIngestionWorkflow");
      expect(deployed.binding.scriptName).toBe(deployed.worker.workerName);

      const workflowName = workflowNameOf(deployed.subscription.source);
      expect(workflowName).toBeTypeOf("string");
      expect(deployed.binding.workflowName).toBe(workflowName);

      // The subscription targets exactly the name the Worker's `workflow`
      // binding uploaded — both sides stay in sync by construction.
      const uploaded = observed.uploaded.WorkflowHost;
      expect(uploaded?.workflowName).toBe(workflowName);
      expect(uploaded?.className).toBe("FileUrlIngestionWorkflow");

      // The name resolves through the registered WorkflowResource, so the
      // subscription is created after `putWorkflow`, on this first deploy.
      // (The Worker's `precreate` publishes its name early, so the Workflow
      // itself may reconcile before or alongside the Worker.)
      expect(observed.order).toContain("Workflow:FileUrlIngestion");
      expect(observed.order.indexOf("Subscription:WorkflowEvents")).toBe(
        observed.order.length - 1,
      );

      yield* stack.destroy();
    }),
);

test.provider(
  "a cross-script Workflow binding exposes the host's Workflow name",
  (stack) =>
    Effect.gen(function* () {
      reset();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const host = yield* Cloudflare.Worker("Host", {
            script,
            env: { MY_WORKFLOW: Cloudflare.Workflow("MyWorkflow") },
          });
          const consumer = yield* Cloudflare.Worker("Consumer", {
            script,
            env: {
              MY_WORKFLOW: Cloudflare.Workflow("MyWorkflow", {
                scriptName: host.workerName,
              }),
            },
          });
          return {
            host: host.env.MY_WORKFLOW.workflowName,
            consumer: consumer.env.MY_WORKFLOW.workflowName,
            consumerScript: consumer.env.MY_WORKFLOW.scriptName,
            hostName: host.workerName,
          };
        }),
      );

      expect(deployed.host).toBeTypeOf("string");
      expect(deployed.consumer).toBe(deployed.host);
      expect(deployed.consumerScript).toBe(deployed.hostName);
      expect(observed.uploaded.Consumer?.workflowName).toBe(deployed.host);

      // Only the host registers the Workflow; the consumer is binding-only.
      expect(
        observed.order.filter((step) => step.startsWith("Workflow:")),
      ).toEqual(["Workflow:MyWorkflow"]);

      yield* stack.destroy();
    }),
);
