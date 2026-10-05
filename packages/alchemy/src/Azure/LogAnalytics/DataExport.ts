import * as operationalinsights from "@distilled.cloud/azure/operationalinsights";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createLogAnalyticsName,
  isWorkspaceOwnedByStack,
  sameText,
} from "./Common.ts";

export interface DataExportProps {
  /** Resource group of the workspace. Changing it replaces the rule. */
  resourceGroup: string;
  /** Workspace whose data is exported. Changing it replaces the rule. */
  workspace: string;
  /**
   * Rule name: 4-63 letters, digits, and hyphens. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the rule.
   */
  name?: string;
  /** Tables to export. Each table must support data export. */
  tableNames: string[];
  /**
   * ARM resource ID of the destination: a storage account, or an Event Hubs
   * namespace. It must be in the workspace's region.
   */
  destinationResourceId: string;
  /**
   * Event hub to send to, for an Event Hubs namespace destination. If
   * omitted, one event hub per table (`am-<table>`) is created.
   */
  eventHubName?: string;
  /**
   * Whether the rule exports data.
   * @default true
   */
  enable?: boolean;
}

export interface DataExport extends Resource<
  "Azure.LogAnalytics.DataExport",
  DataExportProps,
  {
    /** Name of the rule. */
    dataExportName: string;
    /** Workspace whose data is exported. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** ARM resource ID of the rule. */
    dataExportId: string;
    /** GUID of the rule (`properties.dataExportId`). */
    dataExportRuleId: string | undefined;
    /** Destination kind (`StorageAccount` or `EventHub`). */
    destinationType: string | undefined;
    /** Exported tables. */
    tableNames: string[];
    /** Whether the rule exports data. */
    enable: boolean;
  },
  never,
  Providers
> {}

/**
 * A Log Analytics data export rule: continuously copies new records of the
 * selected tables to a storage account or an Event Hubs namespace in the
 * workspace's region.
 *
 * Export rules have no tags; Alchemy treats a rule as owned when its
 * workspace is owned by the current stack and stage. A workspace holds at
 * most 10 enabled rules.
 *
 * @see https://learn.microsoft.com/azure/azure-monitor/logs/logs-data-export
 *
 * ### Exporting to Storage
 * **Example:** Export a custom table to a storage account
 * ```typescript
 * const archive = yield* Azure.Storage.StorageAccount("archive", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const exportRule = yield* Azure.LogAnalytics.DataExport("archive", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: logs.workspaceName,
 *   tableNames: [events.tableName],
 *   destinationResourceId: archive.storageAccountId,
 * });
 * ```
 *
 * ### Exporting to Event Hubs
 * **Example:** Stream tables to one event hub
 * ```typescript
 * const exportRule = yield* Azure.LogAnalytics.DataExport("stream", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: logs.workspaceName,
 *   tableNames: ["AppEvents_CL"],
 *   destinationResourceId: namespace.namespaceId,
 *   eventHubName: "logs",
 * });
 * ```
 *
 * @resource
 */
export const DataExport = Resource<DataExport>("Azure.LogAnalytics.DataExport");

type ObservedExport = operationalinsights.GetDataExportResponse;

const getExport = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  dataExportName: string,
) =>
  orUndefinedIfNotFound(
    operationalinsights.GetDataExport({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      dataExportName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  name: string,
  rule: ObservedExport,
): DataExport["Attributes"] => ({
  dataExportName: name,
  workspace,
  resourceGroup,
  dataExportId: rule.id ?? "",
  dataExportRuleId: rule.properties?.dataExportId,
  destinationType: rule.properties?.destination?.type,
  tableNames: [...(rule.properties?.tableNames ?? [])],
  enable: rule.properties?.enable ?? false,
});

const sortedLower = (values: ReadonlyArray<string> | undefined) =>
  JSON.stringify([...(values ?? [])].map((v) => v.toLowerCase()).sort());

export const DataExportProvider = () =>
  Provider.succeed(DataExport, {
    stables: ["dataExportName", "workspace", "resourceGroup", "dataExportId"],

    // Export rules live inside a workspace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.workspace, output.workspace) ||
        (news.name !== undefined && !sameText(news.name, output.dataExportName))
      ) {
        // A destination may appear in only one rule per workspace, so the
        // old rule must go before its replacement is created.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspace ?? olds?.workspace;
      if (resourceGroup === undefined || workspace === undefined) {
        return undefined;
      }
      const name =
        output?.dataExportName ??
        olds?.name ??
        (yield* createLogAnalyticsName(id, 63));
      const observed = yield* getExport(
        subscriptionId,
        resourceGroup,
        workspace,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, name, observed);
      return (yield* isWorkspaceOwnedByStack(
        subscriptionId,
        resourceGroup,
        workspace,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.OperationalInsights");
      const { resourceGroup, workspace } = news;
      const name =
        news.name ??
        output?.dataExportName ??
        (yield* createLogAnalyticsName(id, 63));
      const enable = news.enable ?? true;

      // Observe.
      let observed = yield* getExport(
        subscriptionId,
        resourceGroup,
        workspace,
        name,
      );

      // Ensure + sync: the PUT is a synchronous upsert of the whole rule.
      const current = observed?.properties;
      if (
        observed === undefined ||
        sortedLower(current?.tableNames) !== sortedLower(news.tableNames) ||
        !sameText(
          current?.destination?.resourceId,
          news.destinationResourceId,
        ) ||
        (current?.destination?.metaData?.eventHubName ?? "") !==
          (news.eventHubName ?? "") ||
        (current?.enable ?? false) !== enable
      ) {
        observed = yield* operationalinsights.DataExportsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          dataExportName: name,
          properties: {
            tableNames: news.tableNames,
            destination: {
              resourceId: news.destinationResourceId,
              metaData: news.eventHubName
                ? { eventHubName: news.eventHubName }
                : undefined,
            },
            enable,
          },
        });
      }

      return toAttrs(resourceGroup, workspace, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        operationalinsights.DeleteDataExport({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          dataExportName: output.dataExportName,
        }),
      );
      yield* waitUntilGone(
        `data export ${output.dataExportName}`,
        getExport(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.dataExportName,
        ),
      );
    }),
  });
