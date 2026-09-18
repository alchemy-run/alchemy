import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as queues from "@distilled.cloud/cloudflare/queues";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as workflows from "@distilled.cloud/cloudflare/workflows";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { AsyncWorkflowWorker } from "./fixtures/workflow-async/stack.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const retry = Effect.retry({
  schedule: Schedule.spaced("3 seconds"),
  times: 10,
});
const hostMain = `${import.meta.dirname}/fixtures/workflow-async/worker.ts`;
const consumerMain = `${import.meta.dirname}/fixtures/workflow-async/consumer.ts`;

const WorkflowStatus = Schema.Struct({
  status: Schema.String,
  output: Schema.optional(
    Schema.NullOr(Schema.Struct({ greeting: Schema.String })),
  ),
  error: Schema.optional(
    Schema.NullOr(Schema.Struct({ message: Schema.optional(Schema.String) })),
  ),
});

const WorkflowEvents = Schema.Array(
  Schema.Struct({
    type: Schema.String,
    source: Schema.Struct({ type: Schema.String, workflowName: Schema.String }),
    payload: Schema.Struct({ instanceId: Schema.String }),
  }),
);

const EnvResponse = Schema.Struct({
  greeting: Schema.String,
  config: Schema.String,
  effect: Schema.String,
  output: Schema.String,
  asset: Schema.String,
});

const getJson = <A>(url: string, schema: Schema.Decoder<A>) =>
  Effect.gen(function* () {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    return yield* client.get(url).pipe(
      Effect.flatMap((res) => res.json),
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      retry,
    );
  });

const runWorkflowToCompletion = (url: string) =>
  Effect.gen(function* () {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const { instanceId } = yield* client
      .post(`${url}/workflow/start/world`)
      .pipe(
        Effect.flatMap((res) => res.json),
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({ instanceId: Schema.String }),
          ),
        ),
        retry,
      );

    const status = yield* getJson(
      `${url}/workflow/status/${instanceId}`,
      WorkflowStatus,
    ).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("3 seconds"),
        until: (s) => s.status === "complete" || s.status === "errored",
        times: 10,
      }),
      Effect.timeout("60 seconds"),
    );
    expect(status.status).toBe("complete");
    expect(status.error).toBeFalsy();
    expect(status.output?.greeting).toBe("Hello, world!");
    return instanceId;
  });

const readWorkflowBinding = (scriptName: string) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const settings = yield* workers.getScriptScriptAndVersionSetting({
      accountId,
      scriptName,
    });
    const bindings = (settings.bindings ?? []).filter(
      (binding) => binding.type === "workflow",
    );
    expect(bindings).toHaveLength(1);
    return bindings[0]!;
  });

const expectWorkerGone = (accountId: string, scriptName: string) =>
  workers.getScriptScriptAndVersionSetting({ accountId, scriptName }).pipe(
    Effect.as(false),
    Effect.catchTag("WorkerNotFound", () => Effect.succeed(true)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: Boolean,
      times: 10,
    }),
    Effect.tap((gone) => Effect.sync(() => expect(gone).toBe(true))),
  );

const expectWorkflowGone = (accountId: string, workflowName: string) =>
  workflows.getWorkflow({ accountId, workflowName }).pipe(
    Effect.as(false),
    Effect.catchTag("WorkflowNotFound", () => Effect.succeed(true)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: Boolean,
      times: 10,
    }),
    Effect.tap((gone) => Effect.sync(() => expect(gone).toBe(true))),
  );

const bindingSnapshot = (binding: Cloudflare.Workflows.WorkflowBinding) => ({
  kind: binding.kind,
  name: binding.name,
  className: binding.className,
  workflowName: binding.workflowName,
  scriptName: binding.scriptName,
  workflowIsOutput: Output.isOutput(binding.workflowName),
  scriptIsOutput: Output.isOutput(binding.scriptName),
});

test.provider(
  "async worker workflow binding exposes workflowName for a first-deployment queue subscription",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const program = Effect.gen(function* () {
        const worker = yield* AsyncWorkflowWorker;
        const queue = yield* Cloudflare.Queues.Queue("WorkflowEventsQueue");
        const subscription = yield* Cloudflare.Queues.Subscription(
          "WorkflowEvents",
          {
            source: {
              type: "workflows.workflow",
              workflowName: worker.env.MY_WORKFLOW.workflowName,
            },
            events: ["instance.completed", "instance.errored"],
            queueId: queue.queueId,
          },
        );
        yield* Cloudflare.Queues.Consumer("WorkflowEventsConsumer", {
          queueId: queue.queueId,
          scriptName: worker.workerName,
          settings: { batchSize: 1, maxWaitTimeMs: 1000 },
        });
        return {
          worker,
          queue,
          subscription,
          binding: bindingSnapshot(worker.env.MY_WORKFLOW),
          env: {
            greeting: worker.env.GREETING,
            config: worker.env.CONFIG,
            effect: worker.env.EFFECT,
            output: worker.env.OUTPUT,
            outputIsOutput: Output.isOutput(worker.env.OUTPUT),
            assets: worker.env.ASSETS,
          },
        };
      });
      const deployed = yield* stack.deploy(program);
      const plan = yield* stack.plan(program);
      expect(plan.resources.Greeting.downstream).toContain("WorkflowEvents");
      expect(
        Object.values(plan.resources).filter(
          (node) => node.resource.Type === "Cloudflare.Workflow",
        ),
      ).toHaveLength(1);

      const { binding, worker, queue, subscription } = deployed;
      expect(binding.workflowIsOutput).toBe(true);
      expect(binding.scriptIsOutput).toBe(true);
      expect(binding.kind).toBe("Cloudflare.Workflow");
      expect(binding.name).toBe("Greeting");
      expect(binding.className).toBe("MyWorkflow");
      expect(binding.scriptName).toBe(worker.workerName);
      expect(deployed.env).toEqual({
        greeting: "hello",
        config: "configured",
        effect: "effect",
        output: "output",
        outputIsOutput: true,
        assets: { kind: "Cloudflare.Workers.Assets" },
      });

      const uploaded = yield* readWorkflowBinding(worker.workerName);
      expect(uploaded.workflowName).toBe(binding.workflowName);
      expect(uploaded.className).toBe(binding.className);
      const observed = yield* workflows.getWorkflow({
        accountId,
        workflowName: binding.workflowName,
      });
      expect(observed.name).toBe(binding.workflowName);
      expect(observed.scriptName).toBe(binding.scriptName);
      expect(observed.className).toBe(binding.className);
      const source = {
        type: "workflows.workflow",
        workflowName: binding.workflowName,
      };
      expect(subscription.source).toEqual(source);
      const liveSubscription = yield* queues.getSubscription({
        accountId,
        subscriptionId: subscription.subscriptionId,
      });
      expect(liveSubscription.source).toEqual(expect.objectContaining(source));
      expect(liveSubscription.destination.queueId).toBe(queue.queueId);

      expect(yield* getJson(`${worker.url}/env`, EnvResponse)).toEqual({
        greeting: "hello",
        config: "configured",
        effect: "effect",
        output: "output",
        asset: "workflow asset\n",
      });
      const instanceId = yield* runWorkflowToCompletion(worker.url!);
      const events = yield* getJson(
        `${worker.url}/events`,
        WorkflowEvents,
      ).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (events) =>
            events.some((event) => event.payload.instanceId === instanceId),
          times: 10,
        }),
        Effect.timeout("60 seconds"),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "cf.workflows.workflow.instance.completed",
          source: expect.objectContaining(source),
          payload: expect.objectContaining({ instanceId }),
        }),
      );
      yield* Effect.logInfo(
        `Workflow queue lifecycle delivery: ${JSON.stringify(events)}`,
      );

      yield* stack.destroy();
      yield* expectWorkerGone(accountId, worker.workerName);
      yield* expectWorkflowGone(accountId, binding.workflowName);
      const queueGone = yield* queues
        .getQueue({ accountId, queueId: queue.queueId })
        .pipe(
          Effect.as(false),
          Effect.catchTag("QueueNotFound", () => Effect.succeed(true)),
        );
      expect(queueGone).toBe(true);
      const subscriptionGone = yield* queues
        .getSubscription({
          accountId,
          subscriptionId: subscription.subscriptionId,
        })
        .pipe(
          Effect.as(false),
          Effect.catchTag("SubscriptionNotFound", () => Effect.succeed(true)),
        );
      expect(subscriptionGone).toBe(true);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "async worker workflow binding accepts scriptName and exposes cross-script identity without duplicate resources",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const deploy = (withConsumer: boolean) =>
        stack.deploy(
          Effect.gen(function* () {
            const host = yield* AsyncWorkflowWorker;
            const consumer = withConsumer
              ? yield* Cloudflare.Worker(
                  "WorkflowConsumer",
                  Effect.succeed({
                    main: consumerMain,
                    env: {
                      MY_WORKFLOW: Cloudflare.Workflow<{ value: string }>(
                        "RemoteGreeting",
                        {
                          className: "MyWorkflow",
                          scriptName: host.workerName,
                        },
                      ),
                    },
                  }),
                )
              : undefined;
            return {
              host,
              consumer,
              hostBinding: bindingSnapshot(host.env.MY_WORKFLOW),
              consumerBinding: consumer
                ? bindingSnapshot(consumer.env.MY_WORKFLOW)
                : undefined,
            };
          }),
        );
      const first = yield* deploy(false);
      const hostWorkflow = yield* workflows.getWorkflow({
        accountId,
        workflowName: first.hostBinding.workflowName,
      });
      const deployed = yield* deploy(true);
      const { host, consumer, hostBinding, consumerBinding } = deployed;
      expect(consumerBinding?.workflowIsOutput).toBe(true);
      expect(consumerBinding?.scriptIsOutput).toBe(true);
      expect(consumerBinding?.workflowName).toBe(hostBinding.workflowName);
      expect(consumerBinding?.scriptName).toBe(host.workerName);
      expect(consumerBinding?.name).toBe("RemoteGreeting");
      expect(
        (yield* readWorkflowBinding(consumer!.workerName)).workflowName,
      ).toBe(hostBinding.workflowName);
      const all = yield* workflows.listWorkflows
        .items({ accountId })
        .pipe(Stream.runCollect);
      const owned = Array.from(all).filter(
        (workflow) =>
          workflow.scriptName === host.workerName ||
          workflow.scriptName === consumer!.workerName,
      );
      expect(owned).toHaveLength(1);
      expect(owned[0]?.id).toBe(hostWorkflow.id);
      expect(owned[0]?.name).toBe(hostBinding.workflowName);
      yield* runWorkflowToCompletion(consumer!.url!);

      yield* stack.destroy();
      yield* expectWorkerGone(accountId, consumer!.workerName);
      yield* expectWorkerGone(accountId, host.workerName);
      yield* expectWorkflowGone(accountId, hostBinding.workflowName);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

const waitForAppliedStepLimit = (workflowName: string, expected: number) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const versions = yield* workflows.listVersions
      .items({ accountId, workflowName })
      .pipe(Stream.runCollect);
    return Array.from(versions).some(
      (version) => version.limits?.steps === expected,
    );
  }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: Boolean,
      times: 10,
    }),
    Effect.tap((applied) => Effect.sync(() => expect(applied).toBe(true))),
  );

test.provider(
  "async worker workflow binding applies a per-workflow step limit",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* Cloudflare.Worker("limits-workflow-worker", {
            main: hostMain,
            env: {
              MY_WORKFLOW: Cloudflare.Workflow("MyWorkflow", {
                limits: { steps: 100 },
              }),
            },
          });
          return { worker, workflowName: worker.env.MY_WORKFLOW.workflowName };
        }),
      );
      yield* waitForAppliedStepLimit(deployed.workflowName, 100);
      yield* stack.destroy();
      yield* expectWorkerGone(accountId, deployed.worker.workerName);
      yield* expectWorkflowGone(accountId, deployed.workflowName);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

const scheduledWorkflowMain = `${import.meta.dirname}/fixtures/workflow-schedules/async-worker.ts`;
const waitForAppliedSchedules = (workflowName: string, expected: string[]) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const workflow = yield* workflows.getWorkflow({ accountId, workflowName });
    const crons = (workflow.schedules ?? []).map((schedule) => schedule.cron);
    return crons;
  }).pipe(
    Effect.flatMap((crons) =>
      crons.length === expected.length &&
      crons.every((cron, index) => cron === expected[index])
        ? Effect.succeed(crons)
        : Effect.fail(
            new Error(`schedules not applied yet: ${JSON.stringify(crons)}`),
          ),
    ),
    retry,
  );

test.provider(
  "async worker workflow binding applies native cron schedules",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const yearly = "0 0 1 1 *";
      const other = "0 0 2 1 *";
      const deployWith = (schedules: string[]) =>
        stack.deploy(
          Effect.gen(function* () {
            const worker = yield* Cloudflare.Worker(
              "scheduled-workflow-worker",
              {
                main: scheduledWorkflowMain,
                env: {
                  HOURLY: Cloudflare.Workflow("HourlyWorkflow", {
                    className: "HourlyWorkflow",
                    schedules,
                  }),
                },
              },
            );
            return { worker, workflowName: worker.env.HOURLY.workflowName };
          }),
        );
      const created = yield* deployWith([yearly]);
      expect(
        yield* waitForAppliedSchedules(created.workflowName, [yearly]),
      ).toEqual([yearly]);
      yield* deployWith([other]);
      expect(
        yield* waitForAppliedSchedules(created.workflowName, [other]),
      ).toEqual([other]);
      yield* deployWith([]);
      expect(yield* waitForAppliedSchedules(created.workflowName, [])).toEqual(
        [],
      );
      yield* stack.destroy();
      yield* expectWorkerGone(accountId, created.worker.workerName);
      yield* expectWorkflowGone(accountId, created.workflowName);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
