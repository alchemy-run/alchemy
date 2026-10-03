import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as developerhub from "@distilled.cloud/azure/developerhub";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getWorkflow = (resourceGroupName: string, workflowName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* developerhub.GetWorkflow({
      subscriptionId,
      resourceGroupName,
      workflowName,
    });
  });

const workflowGone = (resourceGroupName: string, workflowName: string) =>
  getWorkflow(resourceGroupName, workflowName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 20,
    }),
  );

const program = (props: {
  name?: string;
  tags?: Record<string, string>;
  branchName?: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const workflow = yield* Azure.DevHub.Workflow("Workflow", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      tags: props.tags,
      githubWorkflowProfile: {
        repositoryOwner: "alchemy-run",
        repositoryName: "alchemy",
        branchName: props.branchName ?? "main",
        dockerfile: "./Dockerfile",
        dockerBuildContext: ".",
        namespace: "default",
      },
    });
    return { group, workflow };
  });

// Workflows cost nothing, but creating one requires the subscription to have
// authorized the Developer Hub GitHub app (an interactive OAuth grant) and
// opens a pull request against the repository. The trial subscription has no
// grant, so every PUT fails with `DevHubGitHubNotAuthorized` (probe below).
// Run with AZURE_TEST_PAID=1 or AZURE_TEST_DEVHUB=1 on an authorized
// subscription whose GitHub user can open PRs on the repository.
const runDevHub = runPaidOnly || !!process.env.AZURE_TEST_DEVHUB;

test.provider.skipIf(!runDevHub)(
  "create, update tags, replace, and delete a devhub workflow",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ tags: { env: "test" } }));
      const rg = created.group.resourceGroupName;
      const name = created.workflow.workflowName;
      expect(created.workflow.workflowId).toContain(
        "/providers/Microsoft.DevHub/workflows/",
      );
      const observed = yield* getWorkflow(rg, name);
      expect(observed.tags?.env).toEqual("test");
      expect(
        observed.properties?.githubWorkflowProfile?.repositoryName,
      ).toEqual("alchemy");

      // Tags update in place.
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.workflow.workflowName).toEqual(name);
      expect((yield* getWorkflow(rg, name)).tags?.env).toEqual("prod");

      // Renaming replaces the workflow.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-devhub-renamed", tags: { env: "prod" } }),
      );
      expect(replaced.workflow.workflowName).toEqual("alchemy-devhub-renamed");
      expect(
        (yield* getWorkflow(rg, "alchemy-devhub-renamed")).name,
      ).toEqual("alchemy-devhub-renamed");
      expect(yield* workflowGone(rg, name)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* workflowGone(rg, "alchemy-devhub-renamed")).toEqual(
        "gone",
      );
    }),
  {
    timeout: 900_000,
    tags: ["provider:azure", "provider:azure:devhub", "live"],
  },
);

// Ungated probe: without the GitHub OAuth grant the provider surfaces the
// typed rejection and nothing is left behind.
test.provider(
  "workflow create without a GitHub grant fails with DevHubGitHubNotAuthorized",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      if (runDevHub) return;
      const error = yield* stack.deploy(program({})).pipe(Effect.flip);
      expect(error._tag).toEqual("DevHubGitHubNotAuthorized");
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const listed = yield* developerhub.ListWorkflow({ subscriptionId });
      expect(
        (listed.value ?? []).filter((w) => w.tags?.["alchemy::stack"]),
      ).toEqual([]);
      yield* stack.destroy();
    }),
  {
    timeout: 300_000,
    tags: ["provider:azure", "provider:azure:devhub", "live"],
  },
);
