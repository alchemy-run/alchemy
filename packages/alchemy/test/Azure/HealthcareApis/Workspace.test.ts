import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as healthcareapis from "@distilled.cloud/azure/healthcareapis";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getWorkspace = (resourceGroupName: string, workspaceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* healthcareapis.GetWorkspace({
      subscriptionId,
      resourceGroupName,
      workspaceName,
    });
  });

const workspaceGone = (resourceGroupName: string, workspaceName: string) =>
  getWorkspace(resourceGroupName, workspaceName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

const program = (tags: Record<string, string>, location = "eastus") =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const workspace = yield* Azure.HealthcareApis.Workspace("Workspace", {
      resourceGroup: group.resourceGroupName,
      location,
      tags,
    });
    return { group, workspace };
  });

// Workspaces are free; provisioning takes about a minute.
test.provider(
  "create, update tags, replace, and delete a Health Data Services workspace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace } = yield* stack.deploy(
        program({ env: "test" }),
      );
      expect(workspace.workspaceName).toMatch(/^[a-z][a-z0-9]{2,23}$/);
      expect(workspace.location).toEqual("eastus");
      expect(workspace.tags).toEqual({ env: "test" });

      const observed = yield* getWorkspace(
        group.resourceGroupName,
        workspace.workspaceName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.alchemy_id).toEqual("Workspace");

      const updated = yield* stack.deploy(program({ env: "prod" }));
      expect(updated.workspace.workspaceName).toEqual(workspace.workspaceName);
      expect(updated.workspace.tags).toEqual({ env: "prod" });
      const reobserved = yield* getWorkspace(
        group.resourceGroupName,
        workspace.workspaceName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      // Location is immutable: changing it replaces the workspace.
      const moved = yield* stack.deploy(program({ env: "prod" }, "westus2"));
      expect(moved.workspace.location).toEqual("westus2");
      expect(moved.workspace.workspaceId).not.toEqual(workspace.workspaceId);
      const movedObserved = yield* getWorkspace(
        group.resourceGroupName,
        moved.workspace.workspaceName,
      );
      expect(movedObserved.location?.toLowerCase().replace(/\s/g, "")).toEqual(
        "westus2",
      );
      expect(
        yield* workspaceGone(group.resourceGroupName, workspace.workspaceName),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* workspaceGone(
          group.resourceGroupName,
          moved.workspace.workspaceName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:healthcareapis", "live"],
    timeout: 600_000,
  },
);
