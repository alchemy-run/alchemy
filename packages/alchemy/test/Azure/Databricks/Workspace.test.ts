import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as databricks from "@distilled.cloud/azure/databricks";
import * as resources from "@distilled.cloud/azure/resources";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";
import { logLevel, subscription, tags } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getWorkspace = (resourceGroupName: string, workspaceName: string) =>
  Effect.gen(function* () {
    return yield* databricks.GetWorkspace({
      subscriptionId: yield* subscription,
      resourceGroupName,
      workspaceName,
    });
  });

const getGroup = (resourceGroupName: string) =>
  Effect.gen(function* () {
    return yield* resources.GetResourceGroup({
      subscriptionId: yield* subscription,
      resourceGroupName,
    });
  });

/** Poll an out-of-band GET until it reports a typed not-found. */
const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times: 60,
    }),
  );

const program = (props: {
  name?: string;
  prepareEncryption?: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // No secure cluster connectivity: no NAT gateway or public IP in the
    // managed resource group.
    const workspace = yield* Azure.Databricks.Workspace("Workspace", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      sku: "premium",
      enableNoPublicIp: false,
      prepareEncryption: props.prepareEncryption,
      forceDeletion: true,
      tags: props.tags,
    });
    return { group, workspace };
  });

// Premium Hybrid workspace with no clusters: only the managed DBFS storage
// account and VNet bill (cents). ~5 minutes to create, ~5-10 to delete.
test.provider(
  "create, update, and delete a Databricks workspace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      const rg = group.resourceGroupName;
      expect(workspace.workspaceUrl).toContain("azuredatabricks.net");
      expect(workspace.computeMode).toEqual("Hybrid");
      expect(workspace.sku).toEqual("premium");
      expect(workspace.managedResourceGroupId?.toLowerCase()).toContain(
        `databricks-rg-${workspace.workspaceName}`.toLowerCase(),
      );
      const observed = yield* getWorkspace(rg, workspace.workspaceName);
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(observed.properties.parameters?.enableNoPublicIp?.value).toEqual(
        false,
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Workspace");
      const managedGroup = workspace.managedResourceGroupId!.split("/").pop()!;
      const managed = yield* getGroup(managedGroup);
      expect(managed.managedBy?.toLowerCase()).toEqual(
        workspace.workspaceId.toLowerCase(),
      );

      // In place: enable the DBFS managed identity (PUT) and change tags.
      const updated = yield* stack.deploy(
        program({ prepareEncryption: true, tags: { env: "prod" } }),
      );
      expect(updated.workspace.workspaceId).toEqual(workspace.workspaceId);
      expect(updated.workspace.workspaceUrl).toEqual(workspace.workspaceUrl);
      expect(updated.workspace.storageAccountPrincipalId).toBeTruthy();
      const reobserved = yield* getWorkspace(rg, workspace.workspaceName);
      expect(
        reobserved.properties.parameters?.prepareEncryption?.value,
      ).toEqual(true);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* waitGone(getWorkspace(rg, workspace.workspaceName)),
      ).toEqual("gone");
      // Azure removes the managed resource group with the workspace.
      expect(yield* waitGone(getGroup(managedGroup))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Two workspace create + delete cycles: ~14.5 minutes end to end (870s
// measured), at the edge of the per-run budget; cost is still cents.
test.provider.skipIf(!runExpensive)(
  "replace a Databricks workspace on rename",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      const rg = group.resourceGroupName;
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-dbx-replaced", tags: { env: "test" } }),
      );
      expect(replaced.workspace.workspaceName).toEqual("alchemy-dbx-replaced");
      expect(replaced.workspace.workspaceId).not.toEqual(workspace.workspaceId);
      const observed = yield* getWorkspace(rg, "alchemy-dbx-replaced");
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(
        yield* waitGone(getWorkspace(rg, workspace.workspaceName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(getWorkspace(rg, "alchemy-dbx-replaced"))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 1_800_000 },
);
