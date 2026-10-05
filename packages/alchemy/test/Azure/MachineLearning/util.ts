import * as Azure from "@/Azure";
import type { InputProps } from "@/Input";
import * as Output from "@/Output";
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
 * workspace unless `props` (optionally derived from the group) say
 * otherwise.
 */
export const baseWorkspace = <E = never, R = never>(
  props:
    | Partial<InputProps<Azure.MachineLearning.WorkspaceProps>>
    | ((
        group: Azure.Resources.ResourceGroup,
      ) => Effect.Effect<
        Partial<InputProps<Azure.MachineLearning.WorkspaceProps>>,
        E,
        R
      >) = {},
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const extra =
      typeof props === "function" ? yield* props(group) : props;
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
      ...extra,
    });
    return { group, storage, vault, workspace };
  });

/**
 * A hub plus a `Project` workspace under it. Hubs reject compute and
 * endpoints, so workspace-child tests deploy into the project
 * (returned as `workspace`). No hourly charge; ~2-4 minutes.
 */
export const baseProject = (
  props: Partial<InputProps<Azure.MachineLearning.WorkspaceProps>> = {},
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
 * A workspace-based Application Insights component (plus its Log Analytics
 * workspace) for `Default` workspaces. Distilled has no
 * `Microsoft.Insights/components` API, so it is created by an ARM template
 * deployment in the test's resource group and removed with the group (no
 * charge without ingestion).
 */
const appInsightsTemplate = {
  $schema:
    "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  contentVersion: "1.0.0.0",
  variables: { name: "[concat('mlai', uniqueString(resourceGroup().id))]" },
  resources: [
    {
      type: "Microsoft.OperationalInsights/workspaces",
      apiVersion: "2022-10-01",
      name: "[variables('name')]",
      location: "[resourceGroup().location]",
      properties: { sku: { name: "PerGB2018" }, retentionInDays: 30 },
    },
    {
      type: "Microsoft.Insights/components",
      apiVersion: "2020-02-02",
      name: "[variables('name')]",
      location: "[resourceGroup().location]",
      kind: "web",
      dependsOn: [
        "[resourceId('Microsoft.OperationalInsights/workspaces', variables('name'))]",
      ],
      properties: {
        Application_Type: "web",
        WorkspaceResourceId:
          "[resourceId('Microsoft.OperationalInsights/workspaces', variables('name'))]",
      },
    },
  ],
  outputs: {
    componentId: {
      type: "string",
      value: "[resourceId('Microsoft.Insights/components', variables('name'))]",
    },
  },
};

/**
 * A `Default` workspace with a template-deployed Application Insights
 * component (`Default` workspaces require one). No hourly charge;
 * ~3-5 minutes.
 */
export const baseDefault = () =>
  baseWorkspace((group) =>
    Effect.gen(function* () {
      const insights = yield* Azure.Resources.Deployment("AppInsights", {
        resourceGroup: group.resourceGroupName,
        template: appInsightsTemplate,
      });
      return {
        kind: "Default" as const,
        applicationInsights: Output.map(insights.outputs, (outputs) =>
          String(outputs.componentId),
        ),
      };
    }),
  );
