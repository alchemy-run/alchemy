import * as operationalinsights from "@distilled.cloud/azure/operationalinsights";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { sameText } from "./Common.ts";

export type WorkspaceSkuName =
  | "PerGB2018"
  | "CapacityReservation"
  | "LACluster"
  | "Free"
  | "Standard"
  | "Premium"
  | "PerNode"
  | "Standalone";

export type WorkspaceNetworkAccess = "Enabled" | "Disabled" | "SecuredByPerimeter";

export interface WorkspaceFeatureProps {
  /**
   * Use only resource-context permissions: users need access to a resource
   * to read its logs, rather than workspace-wide access.
   * @default Azure's default
   */
  enableLogAccessUsingOnlyResourcePermissions?: boolean;
  /**
   * Disable shared-key (non-Microsoft Entra) authentication. The shared-key
   * attributes are then undefined.
   * @default Azure's default (`false`)
   */
  disableLocalAuth?: boolean;
  /**
   * Remove data after 30 days, regardless of the retention setting.
   * @default Azure's default (`false`)
   */
  immediatePurgeDataOn30Days?: boolean;
  /**
   * Allow data export rules on the workspace.
   * @default Azure's default
   */
  enableDataExport?: boolean;
}

export interface WorkspaceIdentity {
  /** Kind of managed identity attached to the workspace. */
  type: "SystemAssigned" | "UserAssigned" | "None";
  /**
   * ARM resource IDs of user-assigned identities. Required when `type` is
   * `UserAssigned`.
   * @default []
   */
  userAssignedIdentities?: string[];
}

export interface WorkspaceProps {
  /**
   * Resource group the workspace is created in.
   *
   * :::caution
   * Changing it replaces the workspace.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Workspace name: 4-63 letters, digits, and hyphens, starting and ending
   * with a letter or digit. If omitted, a unique name is generated from the
   * app, stage, and logical ID.
   *
   * :::caution
   * Changing it replaces the workspace.
   * :::
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure location of the workspace.
   *
   * :::caution
   * Changing it replaces the workspace.
   * :::
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Pricing tier. Switching to or from `CapacityReservation` is allowed once
   * every 31 days; legacy tiers cannot be selected for new workspaces.
   * @default "PerGB2018"
   */
  sku?: WorkspaceSkuName;
  /**
   * Daily commitment in GB (100, 200, ..., 50000). Only with the
   * `CapacityReservation` SKU.
   * @default not set (required with `CapacityReservation`)
   */
  capacityReservationLevel?: number;
  /**
   * Interactive data retention in days (30-730).
   * @default 30
   */
  retentionInDays?: number;
  /**
   * Daily ingestion cap in GB. `-1` removes the cap. Unset leaves the
   * observed cap unchanged.
   * @default Azure's default (`-1`, no cap)
   */
  dailyQuotaGb?: number;
  /**
   * Whether the public endpoint accepts ingestion: `Enabled`, `Disabled`,
   * or `SecuredByPerimeter`.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccessForIngestion?: WorkspaceNetworkAccess;
  /**
   * Whether the public endpoint accepts queries: `Enabled`, `Disabled`, or
   * `SecuredByPerimeter`.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccessForQuery?: WorkspaceNetworkAccess;
  /**
   * Require customer-managed storage for saved queries.
   * @default Azure's default (`false`)
   */
  forceCmkForQuery?: boolean;
  /**
   * Workspace feature flags. Only the flags you set are managed.
   * @default {}
   */
  features?: WorkspaceFeatureProps;
  /**
   * ARM resource ID of the default data collection rule.
   * @default none
   */
  defaultDataCollectionRuleResourceId?: string;
  /**
   * Managed identity of the workspace.
   * @default the observed identity is kept (none on a new workspace)
   */
  identity?: WorkspaceIdentity;
  /**
   * Delete the workspace permanently instead of leaving it soft-deleted for
   * 14 days. A soft-deleted workspace is recovered — with its old settings
   * and tables — by the next create with the same name in the same resource
   * group, so Alchemy force-deletes by default.
   * @default true
   */
  forceDelete?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface Workspace extends Resource<
  "Azure.LogAnalytics.Workspace",
  WorkspaceProps,
  {
    /** Name of the workspace. */
    workspaceName: string;
    /** Resource group that holds the workspace. */
    resourceGroup: string;
    /** ARM resource ID of the workspace. */
    workspaceId: string;
    /**
     * Workspace GUID used by agents, the Logs Ingestion API, and the Log
     * Analytics query API.
     */
    customerId: string;
    /** Location of the workspace. */
    location: string;
    /** Pricing tier of the workspace. */
    skuName: string;
    /** Interactive data retention in days. */
    retentionInDays: number | undefined;
    /** Daily ingestion cap in GB (`-1` when uncapped). */
    dailyQuotaGb: number | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** Primary shared key (absent when local auth is disabled). */
    primarySharedKey: Redacted.Redacted<string> | undefined;
    /** Secondary shared key (absent when local auth is disabled). */
    secondarySharedKey: Redacted.Redacted<string> | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Monitor Log Analytics workspace
 * (`Microsoft.OperationalInsights/workspaces`): the store that Azure
 * Monitor logs, Application Insights, Container Apps, and Microsoft
 * Sentinel write to, and that you query with KQL.
 *
 * Alchemy creates a pay-as-you-go (`PerGB2018`) workspace with 30 days of
 * retention in the stack's resource group. It has no fixed charge: you pay
 * per GB ingested, and for retention beyond 31 days. Bind it to a runtime
 * to run queries: the query bindings assign **Log Analytics Data Reader**
 * on this workspace only.
 *
 * :::caution[Changing `name`, `resourceGroup`, or `location` replaces the workspace]
 * Alchemy creates a new, empty workspace and deletes the old one with all
 * its logs. Agents and diagnostic settings that write to the old
 * `customerId` stop delivering until you point them at the new one.
 * :::
 *
 * @see https://learn.microsoft.com/azure/azure-monitor/logs/log-analytics-workspace-overview
 *
 * ### Creating a Workspace
 * **Example:** Pay-as-you-go workspace
 * ```typescript
 * const logs = yield* Azure.LogAnalytics.Workspace("logs");
 * // logs.customerId is the workspace GUID agents and the query API use
 * ```
 *
 * **Example:** Workspace with a fixed name and region
 * ```typescript
 * const logs = yield* Azure.LogAnalytics.Workspace("logs", {
 *   name: "contoso-prod-logs",
 *   location: "westeurope",
 * });
 * ```
 *
 * ### Retention and Cost
 * **Example:** 90-day retention and a 5 GB daily cap
 * ```typescript
 * const logs = yield* Azure.LogAnalytics.Workspace("logs", {
 *   retentionInDays: 90,
 *   dailyQuotaGb: 5,
 * });
 * ```
 *
 * **Example:** Commitment tier of 100 GB a day
 * ```typescript
 * const logs = yield* Azure.LogAnalytics.Workspace("logs", {
 *   sku: "CapacityReservation",
 *   capacityReservationLevel: 100,
 * });
 * ```
 *
 * **Example:** Keep one table longer than the rest
 * ```typescript
 * const audit = yield* Azure.LogAnalytics.Table("audit", {
 *   workspace: logs.workspaceName,
 *   name: "Audit_CL",
 *   totalRetentionInDays: 365,
 *   columns: [
 *     { name: "TimeGenerated", type: "dateTime" },
 *     { name: "Actor", type: "string" },
 *   ],
 * });
 * ```
 *
 * ### Access Control
 * **Example:** Microsoft Entra ID only, with resource-context permissions
 * ```typescript
 * const logs = yield* Azure.LogAnalytics.Workspace("logs", {
 *   features: {
 *     disableLocalAuth: true,
 *     enableLogAccessUsingOnlyResourcePermissions: true,
 *   },
 * });
 * // logs.primarySharedKey is undefined: shared keys are off
 * ```
 *
 * **Example:** Close the public endpoints
 * ```typescript
 * const logs = yield* Azure.LogAnalytics.Workspace("logs", {
 *   publicNetworkAccessForIngestion: "Disabled",
 *   publicNetworkAccessForQuery: "Disabled",
 * });
 * ```
 *
 * ### Sending Logs
 * **Example:** Stream Container Apps logs to the workspace
 * ```typescript
 * import type * as Redacted from "effect/Redacted";
 *
 * const logs = yield* Azure.LogAnalytics.Workspace("logs");
 * const env = yield* Azure.ContainerApps.ManagedEnvironment("env", {
 *   appLogsConfiguration: {
 *     destination: "log-analytics",
 *     logAnalyticsConfiguration: {
 *       customerId: logs.customerId,
 *       sharedKey: logs.primarySharedKey.as<Redacted.Redacted<string>>(),
 *     },
 *   },
 * });
 * ```
 *
 * **Example:** Export a table to a storage account
 * ```typescript
 * const archive = yield* Azure.Storage.StorageAccount("archive");
 * yield* Azure.LogAnalytics.DataExport("archive", {
 *   workspace: logs.workspaceName,
 *   tableNames: [audit.tableName],
 *   destinationResourceId: archive.storageAccountId,
 * });
 * ```
 *
 * ### Alerts
 * **Example:** Alert when errors pass a threshold
 * ```typescript
 * yield* Azure.Monitor.ScheduledQueryRule("too-many-errors", {
 *   scopes: [logs.workspaceId],
 *   severity: 2,
 *   evaluationFrequency: "PT5M",
 *   windowSize: "PT15M",
 *   criteria: [
 *     {
 *       query: "AppEvents_CL | where Level == 'error'",
 *       timeAggregation: "Count",
 *       operator: "GreaterThan",
 *       threshold: 10,
 *     },
 *   ],
 * });
 * ```
 *
 * ### Binding to a runtime
 * `ExecuteQuery`, `QueryBatch`, `GetQuery`, `GetMetadata`, and
 * `PostMetadata` assign **Log Analytics Data Reader** on this workspace
 * only. They work on any host: a managed-identity host (an Azure Function,
 * Web App, Container App, container group, or VM) gets the role on its
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal.
 *
 * **Example:** Run a KQL query from an Azure Function
 * ```typescript
 * export default class Reports extends Azure.Functions.Function<Reports>()(
 *   "Reports",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const workspace = yield* Logs;
 *     const executeQuery = yield* Azure.LogAnalytics.ExecuteQuery(workspace);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* executeQuery({
 *           query: "AppEvents_CL | where Level == 'error' | take 10",
 *           timespan: "PT1H",
 *         });
 *         return yield* HttpServerResponse.json({ rows: result.tables[0]?.rows ?? [] });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.LogAnalytics.ExecuteQueryHttp)),
 * ) {}
 * ```
 *
 * ### Runtime Operations
 * **Example:** Two queries in one request
 * ```typescript
 * // init
 * const queryBatch = yield* Azure.LogAnalytics.QueryBatch(workspace);
 *
 * // runtime
 * const results = yield* queryBatch({
 *   requests: [
 *     { id: "errors", body: { query: "AppEvents_CL | where Level == 'error' | count" } },
 *     { id: "total", body: { query: "AppEvents_CL | count" } },
 *   ],
 * });
 * // …provided with Effect.provide(Azure.LogAnalytics.QueryBatchHttp)
 * ```
 *
 * ### Deleting a Workspace
 * Alchemy deletes the workspace permanently by default. With
 * `forceDelete: false`, Azure keeps it soft-deleted for 14 days, and the
 * next create with the same name in the same resource group restores it
 * with its old settings and tables.
 *
 * **Example:** Keep a soft-deleted copy for 14 days
 * ```typescript
 * const logs = yield* Azure.LogAnalytics.Workspace("logs", {
 *   forceDelete: false,
 * });
 * ```
 *
 * **Example:** Keep the workspace when the stack is destroyed
 * ```typescript
 * import * as RemovalPolicy from "alchemy/RemovalPolicy";
 *
 * const logs = yield* Azure.LogAnalytics.Workspace("logs").pipe(RemovalPolicy.retain());
 * ```
 *
 * @resource
 */
export const Workspace = GroupedResource<Workspace>("Azure.LogAnalytics.Workspace");

type ObservedWorkspace = operationalinsights.GetWorkspaceResponse;

const createWorkspaceName = (id: string) =>
  createPhysicalName({ id, maxLength: 63 }).pipe(
    Effect.map((name) => name.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "")),
  );

const getWorkspace = (subscriptionId: string, resourceGroupName: string, workspaceName: string) =>
  orUndefinedIfNotFound(
    operationalinsights.GetWorkspace({
      subscriptionId,
      resourceGroupName,
      workspaceName,
    }),
  );

const secret = (value: string | undefined) =>
  value === undefined ? undefined : Redacted.make(value);

const toAttrs = (
  resourceGroup: string,
  name: string,
  workspace: ObservedWorkspace,
  keys: operationalinsights.SharedKeys | undefined,
): Workspace["Attributes"] => ({
  workspaceName: name,
  resourceGroup,
  workspaceId: workspace.id ?? "",
  customerId: workspace.properties?.customerId ?? "",
  location: workspace.location,
  skuName: workspace.properties?.sku?.name ?? "",
  retentionInDays: workspace.properties?.retentionInDays ?? undefined,
  dailyQuotaGb: workspace.properties?.workspaceCapping?.dailyQuotaGb,
  principalId: workspace.identity?.principalId,
  primarySharedKey: secret(keys?.primarySharedKey),
  secondarySharedKey: secret(keys?.secondarySharedKey),
  tags: userTags(workspace.tags),
});

const getSharedKeys = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  workspace: ObservedWorkspace,
) =>
  workspace.properties?.features?.disableLocalAuth
    ? Effect.succeed(undefined)
    : operationalinsights.GetSharedKeySharedKeys({
        subscriptionId,
        resourceGroupName,
        workspaceName,
      });

const toIdentityInput = (identity: WorkspaceIdentity): operationalinsights.IdentityInput => ({
  type: identity.type,
  userAssignedIdentities: identity.userAssignedIdentities
    ? Object.fromEntries(identity.userAssignedIdentities.map((id) => [id, {}]))
    : undefined,
});

const identityDiffers = (
  observed: operationalinsights.Identity | undefined,
  desired: WorkspaceIdentity,
) => {
  if (!sameText(observed?.type ?? "None", desired.type)) return true;
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  const want = (desired.userAssignedIdentities ?? []).map((id) => id.toLowerCase()).sort();
  return JSON.stringify(have) !== JSON.stringify(want);
};

/**
 * The properties that differ between the observed workspace and the
 * desired props; `undefined` when nothing differs. Props left unset are
 * not managed.
 */
const propertiesDelta = (
  observed: operationalinsights.WorkspaceProperties | undefined,
  news: WorkspaceProps,
): operationalinsights.WorkspacePropertiesInput | undefined => {
  const delta: operationalinsights.WorkspacePropertiesInput = {};
  const skuName = news.sku ?? "PerGB2018";
  if (
    !sameText(observed?.sku?.name, skuName) ||
    (news.capacityReservationLevel !== undefined &&
      observed?.sku?.capacityReservationLevel !== news.capacityReservationLevel)
  ) {
    delta.sku = {
      name: skuName,
      capacityReservationLevel: news.capacityReservationLevel,
    };
  }
  const retention = news.retentionInDays ?? 30;
  if (observed?.retentionInDays !== retention) {
    delta.retentionInDays = retention;
  }
  if (
    news.dailyQuotaGb !== undefined &&
    observed?.workspaceCapping?.dailyQuotaGb !== news.dailyQuotaGb
  ) {
    delta.workspaceCapping = { dailyQuotaGb: news.dailyQuotaGb };
  }
  if (
    news.publicNetworkAccessForIngestion !== undefined &&
    !sameText(observed?.publicNetworkAccessForIngestion, news.publicNetworkAccessForIngestion)
  ) {
    delta.publicNetworkAccessForIngestion = news.publicNetworkAccessForIngestion;
  }
  if (
    news.publicNetworkAccessForQuery !== undefined &&
    !sameText(observed?.publicNetworkAccessForQuery, news.publicNetworkAccessForQuery)
  ) {
    delta.publicNetworkAccessForQuery = news.publicNetworkAccessForQuery;
  }
  if (
    news.forceCmkForQuery !== undefined &&
    (observed?.forceCmkForQuery ?? false) !== news.forceCmkForQuery
  ) {
    delta.forceCmkForQuery = news.forceCmkForQuery;
  }
  const features = news.features ?? {};
  const featureDelta = Object.fromEntries(
    (Object.keys(features) as (keyof WorkspaceFeatureProps)[]).flatMap((key) =>
      features[key] !== undefined && (observed?.features?.[key] ?? false) !== features[key]
        ? [[key, features[key]]]
        : [],
    ),
  );
  if (Object.keys(featureDelta).length > 0) {
    delta.features = featureDelta;
  }
  if (
    news.defaultDataCollectionRuleResourceId !== undefined &&
    !sameText(
      observed?.defaultDataCollectionRuleResourceId,
      news.defaultDataCollectionRuleResourceId,
    )
  ) {
    delta.defaultDataCollectionRuleResourceId = news.defaultDataCollectionRuleResourceId;
  }
  return Object.keys(delta).length > 0 ? delta : undefined;
};

export const WorkspaceProvider = () =>
  Provider.succeed(Workspace, {
    stables: ["workspaceName", "resourceGroup", "workspaceId", "customerId"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(operationalinsights.ListWorkspaces, { subscriptionId });
      return (page.value ?? []).flatMap((workspace) => {
        const group = resourceGroupOf(workspace.id);
        return hasAnyAlchemyTag(workspace.tags) &&
          group !== undefined &&
          workspace.name !== undefined
          ? [toAttrs(group, workspace.name, workspace, undefined)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameText(news.name, output.workspaceName)) ||
        (news.location !== undefined &&
          !sameText(news.location.replaceAll(" ", ""), output.location.replaceAll(" ", "")))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.workspaceName ?? olds?.name ?? (yield* createWorkspaceName(id));
      const observed = yield* getWorkspace(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const keys = yield* getSharedKeys(subscriptionId, resourceGroup, name, observed);
      const attrs = toAttrs(resourceGroup, name, observed, keys);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.OperationalInsights");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.workspaceName ?? (yield* createWorkspaceName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        workspaceName: name,
      };
      const get = getWorkspace(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure: a PUT with the full desired body creates the workspace.
      if (observed === undefined) {
        yield* operationalinsights.WorkspacesCreateOrUpdate({
          ...where,
          location,
          tags,
          identity: news.identity ? toIdentityInput(news.identity) : undefined,
          properties: propertiesDelta(undefined, news),
        });
      } else {
        // Sync: PATCH only the observed deltas.
        const properties = propertiesDelta(observed.properties, news);
        const identity =
          news.identity && identityDiffers(observed.identity, news.identity)
            ? toIdentityInput(news.identity)
            : undefined;
        const tagDelta = tagsDiffer(observed.tags, tags);
        if (properties || identity || tagDelta) {
          yield* operationalinsights.UpdateWorkspace({
            ...where,
            properties,
            identity,
            tags: tagDelta ? tags : undefined,
          });
        }
      }

      observed = yield* waitForProvisioned(
        `Log Analytics workspace ${name}`,
        get,
        (workspace) => workspace.properties?.provisioningState,
        { interval: "3 seconds", times: 60 },
      );
      const keys = yield* getSharedKeys(subscriptionId, resourceGroup, name, observed);
      return toAttrs(resourceGroup, name, observed, keys);
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        operationalinsights.DeleteWorkspace({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspaceName,
          force: olds?.forceDelete ?? true,
        }),
      );
      yield* waitUntilGone(
        `Log Analytics workspace ${output.workspaceName}`,
        getWorkspace(subscriptionId, output.resourceGroup, output.workspaceName),
        { interval: "3 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
