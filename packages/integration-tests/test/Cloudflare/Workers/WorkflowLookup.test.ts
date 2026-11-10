import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import type { Workflow } from "@cloudflare/workers-types";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { AsyncWorkflowWorker } from "./fixtures/workflow-async/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = [
  "provider:cloudflare",
  "provider:cloudflare:worker",
  "provider:cloudflare:workflow",
  "live",
];

const consumerMain = `${import.meta.dirname}/fixtures/workflow-async/consumer.ts`;

type Params = { value: string };

// Compile-time contract: a looked-up Workflow types the consumer's env
// exactly as the props-only form does.
const typedConsumer = Cloudflare.Worker("TypedConsumer", {
  main: consumerMain,
  env: { MY_WORKFLOW: Cloudflare.Workflow.lookup<Params>({ workflowName: "typed" }) },
});
type Extends<A, B> = [A] extends [B] ? true : false;
type Assert<T extends true> = T;
export type _LookupEnvIsTypedWorkflow = Assert<
  Extends<Cloudflare.InferEnv<typeof typedConsumer>["MY_WORKFLOW"], Workflow<Params>>
>;

// The host Worker and its Workflow belong to another stack, as a lookup's
// target always should.
const TargetStack = Alchemy.Stack(
  "WorkflowLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const host = yield* AsyncWorkflowWorker;
    return {
      workerName: host.workerName.as<string>(),
      workflowName: host.env.MY_WORKFLOW.workflowName.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

const readWorkflowBinding = (scriptName: string) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const settings = yield* workers.getScriptScriptAndVersionSetting({ accountId, scriptName });
    return (settings.bindings ?? []).filter((binding) => binding.type === "workflow");
  });

const InstanceStatus = Schema.Struct({
  status: Schema.String,
  output: Schema.optional(Schema.NullOr(Schema.Struct({ greeting: Schema.String }))),
});

// Start an instance through the consumer and wait for it to complete. A new
// workers.dev URL, and a just-created instance, both take a few seconds to
// answer.
const runThroughConsumer = (url: string) =>
  Effect.gen(function* () {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const { instanceId } = yield* client.post(`${url}/workflow/start/lookup`).pipe(
      Effect.flatMap((res) => res.json),
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ instanceId: Schema.String }))),
      Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 15 }),
    );
    return yield* client.get(`${url}/workflow/status/${instanceId}`).pipe(
      Effect.flatMap((res) => res.json),
      Effect.flatMap(Schema.decodeUnknownEffect(InstanceStatus)),
      Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 15 }),
      Effect.repeat({
        schedule: Schedule.spaced("3 seconds"),
        until: (s) => s.status === "complete" || s.status === "errored",
        times: 30,
      }),
    );
  });

test.provider(
  "a looked-up workflow binds in place of the scriptName form, with no change to the Worker",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { workerName, workflowName } = yield* target;

      // The existing, hand-written cross-script form.
      const scriptNameForm = Cloudflare.Worker("workflow-lookup-consumer", {
        main: consumerMain,
        workersDev: true,
        env: {
          MY_WORKFLOW: Cloudflare.Workflow<Params>("RemoteGreeting", {
            className: "MyWorkflow",
            scriptName: workerName,
            workflowName,
          }),
        },
      });
      // The same Worker, binding the Workflow through a lookup.
      const lookupForm = Cloudflare.Worker("workflow-lookup-consumer", {
        main: consumerMain,
        workersDev: true,
        env: { MY_WORKFLOW: Cloudflare.Workflow.lookup<Params>({ workflowName }) },
      });

      const before = yield* stack.deploy(scriptNameForm);
      const bindingBefore = yield* readWorkflowBinding(before.workerName);
      expect(bindingBefore).toEqual([
        expect.objectContaining({
          type: "workflow",
          name: "MY_WORKFLOW",
          workflowName,
          className: "MyWorkflow",
          scriptName: workerName,
        }),
      ]);

      // Switching forms changes nothing on the deployed Worker.
      const plan = yield* stack.plan(lookupForm);
      expect(plan.resources["workflow-lookup-consumer"].action).toBe("noop");
      const after = yield* stack.deploy(lookupForm);
      expect(yield* readWorkflowBinding(after.workerName)).toEqual(bindingBefore);

      // The looked-up binding runs the host's Workflow.
      const status = yield* runThroughConsumer(after.url!);
      expect(status.status).toBe("complete");
      expect(status.output?.greeting).toContain("lookup");

      // Destroying the stack that looked it up leaves the Workflow alone.
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const survivor = yield* workers
        .getScriptScriptAndVersionSetting({ accountId, scriptName: workerName })
        .pipe(Effect.map((s) => (s.bindings ?? []).some((b) => b.type === "workflow")));
      expect(survivor).toBe(true);
    }),
  { tags, timeout: 300_000 },
);

test.provider(
  "a lookup of a missing workflow fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const workflowName = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Worker("workflow-lookup-missing", {
            main: consumerMain,
            env: { MY_WORKFLOW: Cloudflare.Workflow.lookup<Params>({ workflowName }) },
          }),
        ),
        ["LookupNotFoundError", workflowName],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a workflow this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { workflowName: name } = yield* stack.deploy(
        Effect.gen(function* () {
          const host = yield* AsyncWorkflowWorker;
          return { workflowName: host.env.MY_WORKFLOW.workflowName.as<string>() };
        }),
      );
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* AsyncWorkflowWorker;
            yield* Cloudflare.Worker("workflow-lookup-managed-consumer", {
              main: consumerMain,
              env: {
                MY_WORKFLOW: Cloudflare.Workflow.lookup<Params>({ workflowName: name }),
              },
            });
          }),
        ),
        ["LookupOfManagedResourceError"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 180_000 },
);
