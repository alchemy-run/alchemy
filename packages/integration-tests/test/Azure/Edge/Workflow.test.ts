import * as Azure from "@alchemy.run/azure";
import * as edge from "@distilled.cloud/azure/edge";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone, withContext } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getWorkflow = (resourceGroupName: string, contextName: string, workflowName: string) =>
  Effect.gen(function* () {
    return yield* edge.GetWorkflow({
      subscriptionId: yield* subscription,
      resourceGroupName,
      contextName,
      workflowName,
    });
  });

const program = (props: { name?: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const context = yield* Azure.Edge.Context("Context", {
      resourceGroup: group.resourceGroupName,
      capabilities: [{ name: "soap", description: "Soap" }],
      hierarchies: [{ name: "country", description: "Country" }],
    });
    const workflow = yield* Azure.Edge.Workflow("Workflow", {
      resourceGroup: group.resourceGroupName,
      context: context.contextName,
      name: props.name,
    });
    return { group, context, workflow };
  });

// Free control-plane resources; provision in seconds.
test.provider(
  "create, replace, and delete a workflow",
  (stack) =>
    withContext(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { group, context, workflow } = yield* stack.deploy(program({}));
        const get = (name: string) =>
          getWorkflow(group.resourceGroupName, context.contextName, name);
        const observed = yield* get(workflow.workflowName);
        expect(observed.id?.toLowerCase()).toEqual(workflow.workflowId.toLowerCase());
        expect(observed.properties?.provisioningState).toEqual("Succeeded");

        // Redeploy without changes keeps the workflow.
        const again = yield* stack.deploy(program({}));
        expect(again.workflow.workflowId).toEqual(workflow.workflowId);

        // Replacement: a new name.
        const replaced = yield* stack.deploy(program({ name: "alchemy-workflow-renamed" }));
        expect(replaced.workflow.workflowName).toEqual("alchemy-workflow-renamed");
        expect((yield* get("alchemy-workflow-renamed")).properties?.provisioningState).toEqual(
          "Succeeded",
        );
        expect(yield* waitGone(get(workflow.workflowName))).toEqual("gone");

        yield* stack.destroy();
        expect(yield* waitGone(get("alchemy-workflow-renamed"))).toEqual("gone");
      }),
    ).pipe(logLevel),
  { tags, timeout: 600_000 },
);
