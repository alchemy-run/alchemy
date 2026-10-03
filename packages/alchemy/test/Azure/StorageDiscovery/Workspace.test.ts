import * as Azure from "@/Azure";
import { orUndefinedIfNotFound } from "@/Azure/Arm";
import * as Test from "@/Test/Alchemy";
import * as storagediscovery from "@distilled.cloud/azure/storagediscovery";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getWorkspace = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* orUndefinedIfNotFound(
      storagediscovery.GetStorageDiscoveryWorkspace({
        subscriptionId,
        resourceGroupName,
        storageDiscoveryWorkspaceName: name,
      }),
    );
  });

const workspaceGone = (resourceGroupName: string, name: string) =>
  getWorkspace(resourceGroupName, name).pipe(
    Effect.map((w) =>
      w === undefined ? ("gone" as const) : ("found" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 20,
    }),
  );

const program = (props: {
  name?: string;
  description?: string;
  tags?: Record<string, string>;
  scopes: Azure.StorageDiscovery.WorkspaceScope[];
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus2",
    });
    const workspace = yield* Azure.StorageDiscovery.Workspace("Workspace", {
      resourceGroup: group.resourceGroupName,
      location: "eastus2",
      name: props.name,
      description: props.description,
      workspaceRoots: [group.resourceGroupId],
      scopes: props.scopes,
      tags: props.tags,
    });
    return { group, workspace };
  });

// Free SKU: $0, provisions in seconds.
test.provider(
  "create, update, replace, and delete a storage discovery workspace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({
          description: "first",
          scopes: [{ displayName: "Everything" }],
        }),
      );
      const rg = created.group.resourceGroupName;
      const name = created.workspace.workspaceName;
      expect(created.workspace.sku).toEqual("Free");
      expect(created.workspace.workspaceId).toContain(
        "/storageDiscoveryWorkspaces/",
      );
      const observed = yield* getWorkspace(rg, name);
      expect(observed?.properties?.description).toEqual("first");
      expect(observed?.properties?.scopes.map((s) => s.displayName)).toEqual([
        "Everything",
      ]);
      expect(observed?.properties?.workspaceRoots[0]?.toLowerCase()).toEqual(
        created.group.resourceGroupId.toLowerCase(),
      );

      // In-place update: description, a second scope, and a tag.
      const updated = yield* stack.deploy(
        program({
          description: "second",
          tags: { env: "test" },
          scopes: [
            { displayName: "Everything" },
            {
              displayName: "Prod",
              tags: { env: "prod" },
              tagKeysOnly: ["owner"],
            },
          ],
        }),
      );
      expect(updated.workspace.workspaceName).toEqual(name);
      const reobserved = yield* getWorkspace(rg, name);
      expect(reobserved?.properties?.description).toEqual("second");
      expect(reobserved?.tags?.env).toEqual("test");
      const prod = reobserved?.properties?.scopes.find(
        (s) => s.displayName === "Prod",
      );
      expect(prod?.tags?.env).toEqual("prod");
      expect(prod?.tagKeysOnly).toEqual(["owner"]);

      // Renaming replaces the workspace.
      const renamed = yield* stack.deploy(
        program({
          name: "alchemy-sd-renamed",
          description: "second",
          scopes: [{ displayName: "Everything" }],
        }),
      );
      expect(renamed.workspace.workspaceName).toEqual("alchemy-sd-renamed");
      expect(
        (yield* getWorkspace(rg, "alchemy-sd-renamed"))?.properties
          ?.description,
      ).toEqual("second");
      expect(yield* workspaceGone(rg, name)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* workspaceGone(rg, "alchemy-sd-renamed")).toEqual("gone");
    }),
  {
    tags: ["provider:azure", "provider:azure:storagediscovery", "live"],
    timeout: 600_000,
  },
);
