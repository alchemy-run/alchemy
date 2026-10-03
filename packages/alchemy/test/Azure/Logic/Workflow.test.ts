import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as logic from "@distilled.cloud/azure/logic";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const definition = (greeting: string) => ({
  $schema:
    "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
  contentVersion: "1.0.0.0",
  parameters: { greeting: { type: "String" } },
  triggers: {
    manual: { type: "Request", kind: "Http", inputs: { schema: {} } },
  },
  actions: {
    reply: {
      type: "Response",
      kind: "Http",
      inputs: {
        statusCode: 200,
        body: `@{parameters('greeting')} ${greeting}`,
      },
    },
  },
});

const program = (props: {
  name?: string;
  greeting: string;
  parameter: string;
  state?: "Enabled" | "Disabled";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const workflow = yield* Azure.Logic.Workflow("Hello", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      definition: definition(props.greeting),
      parameters: { greeting: { type: "String", value: props.parameter } },
      state: props.state,
      tags: props.tags,
    });
    return { group, workflow };
  });

const getWorkflow = (resourceGroupName: string, workflowName: string) =>
  Effect.gen(function* () {
    return yield* logic.GetWorkflow({
      subscriptionId: yield* subscription,
      resourceGroupName,
      workflowName,
    });
  });

/** POST the request trigger, retrying until it answers with `status`. */
const invoke = (url: Redacted.Redacted<string>, status: number) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.post(Redacted.value(url)).pipe(
      Effect.flatMap((res) =>
        Effect.gen(function* () {
          if (res.status !== status) {
            return yield* Effect.fail(`status ${res.status}` as const);
          }
          return yield* res.text;
        }),
      ),
      Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 20 }),
    );
  });

// Consumption workflows are billed per action execution: a few runs cost
// well under $0.01 and provision in seconds.
test.provider(
  "create, invoke, update, disable, replace, and delete a workflow",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workflow } = yield* stack.deploy(
        program({ greeting: "world", parameter: "hello", tags: { env: "a" } }),
      );
      const rg = group.resourceGroupName;
      expect(workflow.state).toEqual("Enabled");
      expect(workflow.tags).toEqual({ env: "a" });
      expect(Object.keys(workflow.triggerCallbackUrls)).toEqual(["manual"]);
      const observed = yield* getWorkflow(rg, workflow.workflowName);
      expect(observed.tags?.env).toEqual("a");
      expect(observed.tags?.["alchemy::id"]).toEqual("Hello");
      expect(observed.properties?.parameters?.greeting?.value).toEqual("hello");
      expect(yield* invoke(workflow.triggerCallbackUrls.manual!, 200)).toEqual(
        "hello world",
      );

      // A no-op redeploy leaves the workflow version untouched.
      const same = yield* stack.deploy(
        program({ greeting: "world", parameter: "hello", tags: { env: "a" } }),
      );
      expect(same.workflow.version).toEqual(workflow.version);

      // In-place: definition, parameter value, and tags.
      const updated = yield* stack.deploy(
        program({ greeting: "there", parameter: "hi", tags: { env: "b" } }),
      );
      expect(updated.workflow.workflowId).toEqual(workflow.workflowId);
      expect(updated.workflow.version).not.toEqual(workflow.version);
      const reobserved = yield* getWorkflow(rg, workflow.workflowName);
      expect(reobserved.tags?.env).toEqual("b");
      expect(
        yield* invoke(updated.workflow.triggerCallbackUrls.manual!, 200),
      ).toEqual("hi there");

      // Disabled workflows reject trigger calls.
      const disabled = yield* stack.deploy(
        program({
          greeting: "there",
          parameter: "hi",
          state: "Disabled",
          tags: { env: "b" },
        }),
      );
      expect(disabled.workflow.state).toEqual("Disabled");
      const disabledObserved = yield* getWorkflow(rg, workflow.workflowName);
      expect(disabledObserved.properties?.state).toEqual("Disabled");
      const client = yield* HttpClient.HttpClient;
      const rejected = yield* client.post(
        Redacted.value(disabled.workflow.triggerCallbackUrls.manual!),
      );
      expect(rejected.status).not.toEqual(200);

      // Replacement: a new name creates a new workflow and deletes the old.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-logic-test-hello",
          greeting: "there",
          parameter: "hi",
          tags: { env: "b" },
        }),
      );
      expect(replaced.workflow.workflowName).toEqual(
        "alchemy-logic-test-hello",
      );
      expect(yield* waitGone(getWorkflow(rg, workflow.workflowName))).toEqual(
        "gone",
      );
      expect(
        yield* invoke(replaced.workflow.triggerCallbackUrls.manual!, 200),
      ).toEqual("hi there");

      yield* stack.destroy();
      expect(
        yield* waitGone(getWorkflow(rg, replaced.workflow.workflowName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
