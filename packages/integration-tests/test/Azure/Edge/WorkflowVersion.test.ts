import * as Azure from "@alchemy.run/azure";
import * as edge from "@distilled.cloud/azure/edge";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone, withContext } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getVersion = (
  resourceGroupName: string,
  contextName: string,
  workflowName: string,
  versionName: string,
) =>
  Effect.gen(function* () {
    return yield* edge.GetWorkflowVersion({
      subscriptionId: yield* subscription,
      resourceGroupName,
      contextName,
      workflowName,
      versionName,
    });
  });

const program = (props: { version: string; stages: string[] }) =>
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
    });
    const version = yield* Azure.Edge.WorkflowVersion("Version", {
      resourceGroup: group.resourceGroupName,
      context: context.contextName,
      workflow: workflow.workflowName,
      version: props.version,
      stages: props.stages.map((name) => ({ name })),
    });
    return { group, context, workflow, version };
  });

// Free control-plane resources; provision in seconds.
test.provider(
  "create, update, replace, and delete a workflow version",
  (stack) =>
    withContext(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { group, context, workflow, version } = yield* stack.deploy(
          program({ version: "1.0.0", stages: ["canary"] }),
        );
        const get = (name: string) =>
          getVersion(group.resourceGroupName, context.contextName, workflow.workflowName, name);
        expect(version.stageNames).toEqual(["canary"]);
        expect((yield* get("1.0.0")).properties?.stageSpec.map((s) => s.name)).toEqual(["canary"]);

        // In-place: add a stage.
        const updated = yield* stack.deploy(
          program({ version: "1.0.0", stages: ["canary", "fleet"] }),
        );
        expect(updated.version.workflowVersionId).toEqual(version.workflowVersionId);
        expect((yield* get("1.0.0")).properties?.stageSpec.map((s) => s.name)).toEqual([
          "canary",
          "fleet",
        ]);

        // Replacement: a new version name.
        const bumped = yield* stack.deploy(
          program({ version: "1.0.1", stages: ["canary", "fleet"] }),
        );
        expect(bumped.version.version).toEqual("1.0.1");
        expect((yield* get("1.0.1")).properties?.stageSpec.length).toEqual(2);
        expect(yield* waitGone(get("1.0.0"))).toEqual("gone");

        yield* stack.destroy();
        expect(yield* waitGone(get("1.0.1"))).toEqual("gone");
      }),
    ).pipe(logLevel),
  { tags, timeout: 600_000 },
);
