import * as ml from "@distilled.cloud/azure/machinelearningservices";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  containsValue,
  createWorkspaceName,
  identityDiffers,
  type MachineLearningIdentity,
  sameArm,
  toArmIdentity,
} from "./Common.ts";

export type WorkspaceKind = "Default" | "Hub" | "Project" | "FeatureStore";
export type WorkspaceIsolationMode =
  | "Disabled"
  | "AllowInternetOutbound"
  | "AllowOnlyApprovedOutbound";

export interface WorkspaceProps {
  /** Resource group the workspace is created in. Changing it replaces the workspace. */
  resourceGroup: string;
  /**
   * Workspace name: 3-33 letters, digits, `-`, and `_`. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the workspace.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the workspace.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Workspace kind. `Hub` and `Project` are Azure AI Foundry hubs and
   * projects. Changing it replaces the workspace.
   * @default "Default"
   */
  kind?: WorkspaceKind;
  /**
   * ARM resource ID of the storage account the workspace stores artifacts
   * in. Required for `Default` and `Hub` workspaces. Changing it replaces
   * the workspace.
   */
  storageAccount?: string;
  /**
   * ARM resource ID of the Key Vault that holds workspace secrets. Required
   * for `Default` and `Hub` workspaces. Changing it replaces the workspace.
   */
  keyVault?: string;
  /**
   * ARM resource ID of the Application Insights component for telemetry.
   * Can be attached later but not detached.
   */
  applicationInsights?: string;
  /**
   * ARM resource ID of the container registry that holds environment
   * images. Can be attached later but not detached.
   */
  containerRegistry?: string;
  /**
   * ARM resource ID of the hub workspace a `Project` belongs to. Changing it
   * replaces the workspace.
   */
  hubResourceId?: string;
  /**
   * Reduce the diagnostic data Microsoft collects (high business impact).
   * Set at creation only; changing it replaces the workspace.
   * @default false
   */
  hbiWorkspace?: boolean;
  /** Display name shown in the studio. */
  friendlyName?: string;
  /** Description of the workspace. */
  description?: string;
  /**
   * Whether the workspace endpoints accept public traffic.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * Managed virtual network isolation mode. It can only become stricter
   * (`Disabled` → `AllowInternetOutbound` → `AllowOnlyApprovedOutbound`).
   * @default Azure's default (`Disabled`)
   */
  isolationMode?: WorkspaceIsolationMode;
  /**
   * How the system datastores authenticate to the storage account.
   * @default Azure's default (`AccessKey`)
   */
  systemDatastoresAuthMode?: "AccessKey" | "Identity" | "UserDelegationSAS";
  /**
   * Managed identity of the workspace.
   * @default { type: "SystemAssigned" }
   */
  identity?: MachineLearningIdentity;
  /**
   * ARM resource ID of the user-assigned identity the workspace uses for
   * its own access when `identity` is user-assigned.
   */
  primaryUserAssignedIdentity?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Workspace extends Resource<
  "Azure.MachineLearning.Workspace",
  WorkspaceProps,
  {
    /** Name of the workspace. */
    workspaceName: string;
    /** ARM resource ID of the workspace. */
    workspaceId: string;
    /** Immutable GUID Azure Machine Learning assigns to the workspace. */
    mlWorkspaceId: string;
    /** Resource group that holds the workspace. */
    resourceGroup: string;
    /** Location of the workspace. */
    location: string;
    /** Workspace kind. */
    kind: string;
    /** ARM resource ID of the associated storage account. */
    storageAccount: string | undefined;
    /** ARM resource ID of the associated Key Vault. */
    keyVault: string | undefined;
    /** ARM resource ID of the hub a `Project` belongs to. */
    hubResourceId: string | undefined;
    /** Discovery URL of the workspace's regional API endpoints. */
    discoveryUrl: string | undefined;
    /** MLflow tracking URI of the workspace. */
    mlFlowTrackingUri: string | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Machine Learning workspace — the top-level resource that holds
 * compute, datastores, connections, endpoints, and experiment history.
 * A `Default` workspace needs a storage account and a Key Vault; `Hub` and
 * `Project` kinds back Azure AI Foundry.
 *
 * Deleting the workspace purges it (`forceToPurge`) so its name is
 * immediately reusable; the storage account, Key Vault, and other
 * associated resources are left in place.
 *
 * @see https://learn.microsoft.com/azure/machine-learning/concept-workspace
 *
 * ### Creating a Workspace
 * **Example:** Workspace with a storage account and Key Vault
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("ml");
 * const storage = yield* Azure.Storage.StorageAccount("artifacts", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const workspace = yield* Azure.MachineLearning.Workspace("ws", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: storage.storageAccountId,
 *   keyVault: vaultId,
 *   friendlyName: "Research",
 * });
 * ```
 *
 * ### Network Isolation
 * **Example:** Managed virtual network that allows internet outbound
 * ```typescript
 * const workspace = yield* Azure.MachineLearning.Workspace("ws", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: storage.storageAccountId,
 *   keyVault: vaultId,
 *   isolationMode: "AllowInternetOutbound",
 * });
 * ```
 *
 * @resource
 */
export const Workspace = Resource<Workspace>("Azure.MachineLearning.Workspace");

type ObservedWorkspace = ml.Workspace;

const getWorkspace = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
) =>
  orUndefinedIfNotFound(
    ml.GetWorkspace({ subscriptionId, resourceGroupName, workspaceName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  workspace: ObservedWorkspace,
): Workspace["Attributes"] => ({
  workspaceName: name,
  workspaceId: workspace.id ?? "",
  mlWorkspaceId: workspace.properties?.workspaceId ?? "",
  resourceGroup,
  location: workspace.location ?? "",
  kind: workspace.kind ?? "Default",
  storageAccount: workspace.properties?.storageAccount,
  keyVault: workspace.properties?.keyVault,
  hubResourceId: workspace.properties?.hubResourceId,
  discoveryUrl: workspace.properties?.discoveryUrl,
  mlFlowTrackingUri: workspace.properties?.mlFlowTrackingUri,
  principalId: workspace.identity?.principalId,
  tags: userTags(workspace.tags),
});

const changedOptional = (
  desired: string | undefined,
  observed: string | undefined,
) => desired !== undefined && !sameArm(desired, observed);

export const WorkspaceProvider = () =>
  Provider.succeed(Workspace, {
    stables: [
      "workspaceName",
      "workspaceId",
      "mlWorkspaceId",
      "resourceGroup",
      "location",
      "kind",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* ml
        .ListWorkspaceBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListWorkspaceBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((workspace) => {
        const group = resourceGroupOf(workspace.id);
        return hasAnyAlchemyTag(workspace.tags) &&
          group !== undefined &&
          workspace.name !== undefined
          ? [toAttrs(group, workspace.name, workspace)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // Associated resource IDs and the resource group are stable upstream;
      // an unresolved one means that resource is being replaced.
      if (
        !isResolved(news.resourceGroup) ||
        !isResolved(news.storageAccount) ||
        !isResolved(news.keyVault) ||
        !isResolved(news.hubResourceId)
      ) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.workspaceName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        !sameArm(news.kind ?? "Default", output.kind) ||
        changedOptional(news.storageAccount, output.storageAccount) ||
        changedOptional(news.keyVault, output.keyVault) ||
        changedOptional(news.hubResourceId, output.hubResourceId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.workspaceName ?? olds?.name ?? (yield* createWorkspaceName(id));
      const observed = yield* getWorkspace(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(
        subscriptionId,
        "Microsoft.MachineLearningServices",
      );
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.workspaceName ?? (yield* createWorkspaceName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const identity = news.identity ?? { type: "SystemAssigned" as const };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        workspaceName: name,
      };
      const label = `machine learning workspace ${name}`;
      const get = getWorkspace(subscriptionId, resourceGroup, name);
      const waitReady = waitForProvisioned(
        label,
        get,
        (workspace) => workspace.properties?.provisioningState,
        { interval: "5 seconds", times: 72 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* ml.WorkspacesCreateOrUpdate({
          ...where,
          location,
          kind: news.kind ?? "Default",
          identity: toArmIdentity(identity),
          tags,
          properties: {
            storageAccount: news.storageAccount,
            keyVault: news.keyVault,
            applicationInsights: news.applicationInsights,
            containerRegistry: news.containerRegistry,
            hubResourceId: news.hubResourceId,
            hbiWorkspace: news.hbiWorkspace,
            friendlyName: news.friendlyName,
            description: news.description,
            publicNetworkAccess: news.publicNetworkAccess,
            systemDatastoresAuthMode: news.systemDatastoresAuthMode,
            primaryUserAssignedIdentity: news.primaryUserAssignedIdentity,
            managedNetwork: news.isolationMode
              ? { isolationMode: news.isolationMode }
              : undefined,
          },
        });
      }
      observed = yield* waitReady;

      // Sync mutable aspects against observed state; PATCH only deltas.
      const props = observed.properties ?? {};
      const changed: ml.WorkspacePropertiesUpdateParametersInput = {};
      if (
        news.friendlyName !== undefined &&
        props.friendlyName !== news.friendlyName
      ) {
        changed.friendlyName = news.friendlyName;
      }
      if (
        news.description !== undefined &&
        props.description !== news.description
      ) {
        changed.description = news.description;
      }
      if (
        news.publicNetworkAccess !== undefined &&
        props.publicNetworkAccess !== news.publicNetworkAccess
      ) {
        changed.publicNetworkAccess = news.publicNetworkAccess;
      }
      if (
        changedOptional(news.applicationInsights, props.applicationInsights)
      ) {
        changed.applicationInsights = news.applicationInsights;
      }
      if (changedOptional(news.containerRegistry, props.containerRegistry)) {
        changed.containerRegistry = news.containerRegistry;
      }
      if (
        news.systemDatastoresAuthMode !== undefined &&
        props.systemDatastoresAuthMode !== news.systemDatastoresAuthMode
      ) {
        changed.systemDatastoresAuthMode = news.systemDatastoresAuthMode;
      }
      if (
        changedOptional(
          news.primaryUserAssignedIdentity,
          props.primaryUserAssignedIdentity,
        )
      ) {
        changed.primaryUserAssignedIdentity = news.primaryUserAssignedIdentity;
      }
      if (
        news.isolationMode !== undefined &&
        (props.managedNetwork?.isolationMode ?? "Disabled") !==
          news.isolationMode
      ) {
        changed.managedNetwork = { isolationMode: news.isolationMode };
      }
      const tagsChanged = tagsDiffer(observed.tags, tags);
      const identityChanged = identityDiffers(observed.identity, identity);
      if (Object.keys(changed).length > 0 || tagsChanged || identityChanged) {
        yield* ml.UpdateWorkspace({
          ...where,
          properties: Object.keys(changed).length > 0 ? changed : undefined,
          tags: tagsChanged ? tags : undefined,
          identity: identityChanged ? toArmIdentity(identity) : undefined,
        });
        // The PATCH is applied asynchronously: GET keeps returning the old
        // values (with `Succeeded`) for a while, so wait for convergence.
        observed = yield* waitForProvisioned(
          label,
          get,
          (workspace) => {
            const state = workspace.properties?.provisioningState;
            if (state !== undefined && state !== "Succeeded") return state;
            return containsValue(workspace.properties, changed) &&
              !tagsDiffer(workspace.tags, tags) &&
              !identityDiffers(workspace.identity, identity)
              ? "Succeeded"
              : "Updating";
          },
          { interval: "5 seconds", times: 72 },
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // Purge so the deterministic name is reusable immediately (a plain
      // delete soft-deletes the workspace for 14 days).
      // A hub rejects deletion while its projects (even ones being deleted)
      // still exist, and any workspace while just-deleted children linger.
      yield* ignoreNotFound(
        ml
          .DeleteWorkspace({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            workspaceName: output.workspaceName,
            forceToPurge: true,
          })
          .pipe(
            Effect.retry({
              while: (e) =>
                e._tag === "MachineLearningHubHasProjects" ||
                e._tag === "CannotDeleteResource",
              schedule: Schedule.spaced("10 seconds"),
              times: 18,
            }),
          ),
      );
      yield* waitUntilGone(
        `machine learning workspace ${output.workspaceName}`,
        getWorkspace(
          subscriptionId,
          output.resourceGroup,
          output.workspaceName,
        ),
        { interval: "5 seconds", times: 72 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
