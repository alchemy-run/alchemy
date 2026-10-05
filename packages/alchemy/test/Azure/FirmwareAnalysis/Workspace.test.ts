import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as fist from "@distilled.cloud/azure/fist";
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
    return yield* fist.GetWorkspace({
      subscriptionId,
      resourceGroupName,
      workspaceName,
    });
  });

const workspaceGone = (resourceGroupName: string, workspaceName: string) =>
  getWorkspace(resourceGroupName, workspaceName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (props: {
  name?: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const workspace = yield* Azure.FirmwareAnalysis.Workspace("Firmware", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      location: "eastus",
      sku: { name: "Free" },
      tags: props.tags,
    });
    return { group, workspace };
  });

// Workspaces have no standing cost (Free SKU) and provision in seconds.
test.provider(
  "create, update, replace, and delete a firmware analysis workspace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      expect(workspace.workspaceName).toMatch(/^[A-Za-z0-9-]+$/);
      expect(workspace.workspaceId).toContain(
        "Microsoft.IoTFirmwareDefense/workspaces",
      );
      expect(workspace.provisioningState).toEqual("Succeeded");
      expect(workspace.skuName).toEqual("Free");

      const observed = yield* getWorkspace(
        group.resourceGroupName,
        workspace.workspaceName,
      );
      expect(observed.location.replaceAll(" ", "").toLowerCase()).toEqual(
        "eastus",
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Firmware");

      // In-place update: tags.
      const updated = yield* stack.deploy(
        program({ tags: { env: "prod" } }),
      );
      expect(updated.workspace.workspaceId).toEqual(workspace.workspaceId);
      expect(updated.workspace.tags).toEqual({ env: "prod" });
      const reobserved = yield* getWorkspace(
        group.resourceGroupName,
        workspace.workspaceName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: the name is immutable. Firmware analysis only accepts
      // new workspaces in a few regions (westeurope rejects new customers),
      // so the replacement changes the name instead of the location.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-fist-replaced", tags: { env: "prod" } }),
      );
      expect(replaced.workspace.workspaceName).toEqual("alchemy-fist-replaced");
      expect(replaced.workspace.workspaceId).not.toEqual(workspace.workspaceId);
      const replacedObserved = yield* getWorkspace(
        group.resourceGroupName,
        replaced.workspace.workspaceName,
      );
      expect(replacedObserved.tags?.env).toEqual("prod");
      expect(
        yield* workspaceGone(group.resourceGroupName, workspace.workspaceName),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* workspaceGone(
          group.resourceGroupName,
          replaced.workspace.workspaceName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:firmwareanalysis", "live"],
    timeout: 600_000,
  },
);
