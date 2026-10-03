import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = [
  "provider:azure",
  "provider:azure:machinelearning",
  "live",
];

export const location = "eastus";

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/** Poll an out-of-band GET until it reports a typed not-found. */
export const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 36,
    }),
  );

/**
 * The resource group, storage account, Key Vault, and workspace every
 * workspace-child test deploys (no hourly charge; ~2-4 minutes). A `Hub`
 * workspace: a `Default` workspace also requires an Application Insights
 * component, which Alchemy cannot create yet.
 */
export const baseWorkspace = (
  props: Partial<Azure.MachineLearning.WorkspaceProps> = {},
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const storage = yield* Azure.Storage.StorageAccount("Artifacts", {
      resourceGroup: group.resourceGroupName,
      location,
    });
    // Access-policy mode: the workspace adds its own policy to the vault.
    const vault = yield* Azure.KeyVault.Vault("Secrets", {
      resourceGroup: group.resourceGroupName,
      location,
      enableRbacAuthorization: false,
      softDeleteRetentionInDays: 7,
    });
    const workspace = yield* Azure.MachineLearning.Workspace("Workspace", {
      resourceGroup: group.resourceGroupName,
      location,
      storageAccount: storage.storageAccountId,
      keyVault: vault.vaultId,
      kind: "Hub",
      ...props,
    });
    return { group, storage, vault, workspace };
  });

/**
 * A hub plus a `Project` workspace under it. Hubs reject compute and
 * endpoints, so workspace-child tests deploy into the project
 * (returned as `workspace`). No hourly charge; ~2-4 minutes.
 */
export const baseProject = (
  props: Partial<Azure.MachineLearning.WorkspaceProps> = {},
) =>
  Effect.gen(function* () {
    const base = yield* baseWorkspace();
    const workspace = yield* Azure.MachineLearning.Workspace("Project", {
      resourceGroup: base.group.resourceGroupName,
      location,
      kind: "Project",
      hubResourceId: base.workspace.workspaceId,
      ...props,
    });
    return { ...base, hub: base.workspace, workspace };
  });

/**
 * An existing Application Insights component (ARM ID) for `Default`
 * workspaces. Alchemy cannot create one yet (distilled has no
 * `Microsoft.Insights/components` API), so tests that need a `Default`
 * workspace (AmlCompute, managed online endpoints) skip without it.
 */
export const appInsightsId = process.env.AZURE_ML_APP_INSIGHTS_ID;

/** A `Default` workspace (needs {@link appInsightsId}). */
export const baseDefault = () =>
  baseWorkspace({ kind: "Default", applicationInsights: appInsightsId });
