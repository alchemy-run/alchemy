import * as monitoringservice from "@distilled.cloud/azure/monitoringservice";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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

export interface WorkspaceIdentity {
  /** Kind of managed identity attached to the workspace. */
  type:
    | "None"
    | "SystemAssigned"
    | "UserAssigned"
    | "SystemAssigned,UserAssigned";
  /**
   * ARM resource IDs of user-assigned identities. Required when `type`
   * includes `UserAssigned`.
   */
  userAssignedIdentities?: string[];
}

export interface WorkspaceProps {
  /**
   * Resource group the workspace is created in. Changing it replaces the
   * workspace.
   */
  resourceGroup: string;
  /**
   * Workspace name: 4-44 letters, digits, and hyphens, not starting or
   * ending with a hyphen. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the workspace.
   */
  name?: string;
  /**
   * Azure location of the workspace. Changing it replaces the workspace.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Whether the workspace's query and ingestion endpoints are reachable
   * from public networks.
   * @default "Enabled"
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * Allow metric queries authorized with permissions on the source
   * resource rather than on the workspace. Unset leaves the service
   * default unmanaged.
   */
  enableAccessUsingResourcePermissions?: boolean;
  /** Managed identity of the workspace. Unset leaves identity unmanaged. */
  identity?: WorkspaceIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Workspace extends Resource<
  "Azure.Monitor.Workspace",
  WorkspaceProps,
  {
    /** Name of the workspace. */
    workspaceName: string;
    /** Resource group that holds the workspace. */
    resourceGroup: string;
    /** ARM resource ID of the workspace. */
    workspaceId: string;
    /** Immutable GUID of the workspace (`properties.accountId`). */
    accountId: string;
    /** Location of the workspace. */
    location: string;
    /** Prometheus query endpoint (PromQL HTTP API base URL). */
    prometheusQueryEndpoint: string | undefined;
    /** ARM resource ID of the default data collection rule. */
    dataCollectionRuleResourceId: string | undefined;
    /** ARM resource ID of the default data collection endpoint. */
    dataCollectionEndpointResourceId: string | undefined;
    /** Immutable ID of the default data collection rule. */
    dataCollectionRuleImmutableId: string | undefined;
    /** Metrics ingestion endpoint (Prometheus remote-write target). */
    metricsIngestionEndpoint: string | undefined;
    /** Public network access setting. */
    publicNetworkAccess: string | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Monitor workspace — the managed Prometheus metrics store used by
 * AKS managed Prometheus, Azure Managed Grafana, and Prometheus
 * remote-write.
 *
 * Creating a workspace also provisions a managed resource group
 * (`MA_<name>_<location>_managed`) holding the default data collection
 * rule and endpoint; Azure deletes it together with the workspace. The
 * workspace itself has no fixed charge — you pay per ingested sample and
 * per query.
 *
 * @see https://learn.microsoft.com/azure/azure-monitor/essentials/azure-monitor-workspace-overview
 *
 * ### Creating a Workspace
 * **Example:** Managed Prometheus workspace
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const metrics = yield* Azure.Monitor.Workspace("metrics", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * // metrics.prometheusQueryEndpoint, metrics.metricsIngestionEndpoint
 * ```
 *
 * ### Securing a Workspace
 * **Example:** Private-only workspace with resource-context access
 * ```typescript
 * const metrics = yield* Azure.Monitor.Workspace("metrics", {
 *   resourceGroup: group.resourceGroupName,
 *   publicNetworkAccess: "Disabled",
 *   enableAccessUsingResourcePermissions: true,
 *   tags: { team: "platform" },
 * });
 * ```
 *
 * @resource
 */
export const Workspace = Resource<Workspace>("Azure.Monitor.Workspace");

type ObservedWorkspace =
  | monitoringservice.GetAzureMonitorWorkspaceResponse
  | monitoringservice.AzureMonitorWorkspaceResource;

const sameText = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

const sameLocation = (a: string, b: string) =>
  sameText(a.replaceAll(" ", ""), b.replaceAll(" ", ""));

const createWorkspaceName = (id: string) =>
  createPhysicalName({ id, maxLength: 44 }).pipe(
    Effect.map((name) =>
      name.replace(/[^a-zA-Z0-9-]/g, "-").replace(/^-+|-+$/g, ""),
    ),
  );

const getWorkspace = (
  subscriptionId: string,
  resourceGroupName: string,
  azureMonitorWorkspaceName: string,
) =>
  orUndefinedIfNotFound(
    monitoringservice.GetAzureMonitorWorkspace({
      subscriptionId,
      resourceGroupName,
      azureMonitorWorkspaceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  workspace: ObservedWorkspace,
): Workspace["Attributes"] => {
  const ingestion = workspace.properties?.defaultIngestionSettings;
  return {
    workspaceName: name,
    resourceGroup,
    workspaceId: workspace.id ?? "",
    accountId: workspace.properties?.accountId ?? "",
    location: workspace.location,
    prometheusQueryEndpoint:
      workspace.properties?.metrics?.prometheusQueryEndpoint,
    dataCollectionRuleResourceId: ingestion?.dataCollectionRuleResourceId,
    dataCollectionEndpointResourceId:
      ingestion?.dataCollectionEndpointResourceId,
    dataCollectionRuleImmutableId: ingestion?.dataCollectionRuleImmutableId,
    metricsIngestionEndpoint: ingestion?.ingestionEndpoints?.metrics,
    publicNetworkAccess: workspace.properties?.publicNetworkAccess,
    principalId: workspace.identity?.principalId,
    tags: userTags(workspace.tags),
  };
};

const toIdentityInput = (identity: WorkspaceIdentity) => ({
  type: identity.type,
  userAssignedIdentities: identity.userAssignedIdentities
    ? Object.fromEntries(identity.userAssignedIdentities.map((id) => [id, {}]))
    : undefined,
});

const observedIdentity = (observed: ObservedWorkspace["identity"]) =>
  observed === undefined
    ? undefined
    : {
        type: observed.type,
        userAssignedIdentities: observed.userAssignedIdentities
          ? Object.fromEntries(
              Object.keys(observed.userAssignedIdentities).map((id) => [
                id,
                {},
              ]),
            )
          : undefined,
      };

const identityDiffers = (
  observed: ObservedWorkspace["identity"],
  desired: WorkspaceIdentity,
) => {
  if (!sameText((observed?.type ?? "None").replaceAll(" ", ""), desired.type)) {
    return true;
  }
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  const want = (desired.userAssignedIdentities ?? [])
    .map((id) => id.toLowerCase())
    .sort();
  return JSON.stringify(have) !== JSON.stringify(want);
};

/**
 * The workspace properties that differ between observed and desired;
 * `undefined` when nothing differs. Props left unset are not managed.
 */
const propertiesDelta = (
  observed: monitoringservice.AzureMonitorWorkspace | undefined,
  news: WorkspaceProps,
): monitoringservice.AzureMonitorWorkspaceInput | undefined => {
  const delta: monitoringservice.AzureMonitorWorkspaceInput = {};
  const access = news.publicNetworkAccess ?? "Enabled";
  if (!sameText(observed?.publicNetworkAccess ?? "Enabled", access)) {
    delta.publicNetworkAccess = access;
  }
  if (
    news.enableAccessUsingResourcePermissions !== undefined &&
    observed?.metrics?.enableAccessUsingResourcePermissions !==
      news.enableAccessUsingResourcePermissions
  ) {
    delta.metrics = {
      enableAccessUsingResourcePermissions:
        news.enableAccessUsingResourcePermissions,
    };
  }
  return Object.keys(delta).length > 0 ? delta : undefined;
};

export const WorkspaceProvider = () =>
  Provider.succeed(Workspace, {
    stables: ["workspaceName", "resourceGroup", "workspaceId", "accountId"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* monitoringservice
        .ListAzureMonitorWorkspaceBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListAzureMonitorWorkspaceBySubscription", page),
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
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameText(news.name, output.workspaceName)) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location))
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
      yield* ensureRegistered(subscriptionId, "Microsoft.Monitor");
      // The workspace provisions its default DCR/DCE in Microsoft.Insights.
      yield* ensureRegistered(subscriptionId, "Microsoft.Insights");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.workspaceName ?? (yield* createWorkspaceName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        azureMonitorWorkspaceName: name,
      };
      const get = getWorkspace(subscriptionId, resourceGroup, name);

      // Observe.
      const observed = yield* get;

      // Ensure: PUT the full desired body when the workspace is missing.
      if (observed === undefined) {
        yield* monitoringservice.AzureMonitorWorkspacesCreateOrUpdate({
          ...where,
          location,
          tags,
          identity: news.identity ? toIdentityInput(news.identity) : undefined,
          properties: propertiesDelta(undefined, news),
        });
      } else {
        // Sync against observed state. ARM ignores `properties` and
        // `identity` on PATCH for this type, so those deltas re-PUT the
        // full body (unmanaged settings carried over from observed);
        // tag-only deltas use PATCH.
        const properties = propertiesDelta(observed.properties, news);
        const identity =
          news.identity && identityDiffers(observed.identity, news.identity)
            ? toIdentityInput(news.identity)
            : undefined;
        const tagDelta = tagsDiffer(observed.tags, tags);
        if (properties || identity) {
          yield* monitoringservice.AzureMonitorWorkspacesCreateOrUpdate({
            ...where,
            location: observed.location,
            tags,
            identity: news.identity
              ? toIdentityInput(news.identity)
              : observedIdentity(observed.identity),
            properties: {
              publicNetworkAccess: news.publicNetworkAccess ?? "Enabled",
              metrics: {
                enableAccessUsingResourcePermissions:
                  news.enableAccessUsingResourcePermissions ??
                  observed.properties?.metrics
                    ?.enableAccessUsingResourcePermissions,
              },
            },
          });
        } else if (tagDelta) {
          yield* monitoringservice.UpdateAzureMonitorWorkspace({
            ...where,
            tags,
          });
        }
      }

      const final = yield* waitForProvisioned(
        `Azure Monitor workspace ${name}`,
        get,
        (workspace) => workspace.properties?.provisioningState,
        { interval: "3 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, name, final);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // A DELETE accepted right after a PUT can be dropped while the
      // workspace is still settling its managed resources; re-issue it
      // when the workspace outlives a wait window.
      yield* ignoreNotFound(
        monitoringservice.DeleteAzureMonitorWorkspace({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          azureMonitorWorkspaceName: output.workspaceName,
        }),
      ).pipe(
        Effect.andThen(
          waitUntilGone(
            `Azure Monitor workspace ${output.workspaceName}`,
            getWorkspace(
              subscriptionId,
              output.resourceGroup,
              output.workspaceName,
            ),
            { interval: "5 seconds", times: 24 },
          ),
        ),
        Effect.retry({
          while: (e) => e._tag === "Azure.DeleteTimedOut",
          times: 4,
        }),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
