import * as operationalinsights from "@distilled.cloud/azure/operationalinsights";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound, waitUntilGone } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { createLogAnalyticsName, isWorkspaceOwnedByStack, sameText } from "./Common.ts";

/**
 * Kind of legacy-agent data source, e.g. `WindowsEvent`,
 * `WindowsPerformanceCounter`, `LinuxSyslog`, or `CustomLog`. Each kind
 * takes its own `properties` shape.
 */
export type DataSourceKind =
  | "WindowsEvent"
  | "WindowsPerformanceCounter"
  | "IISLogs"
  | "LinuxSyslog"
  | "LinuxSyslogCollection"
  | "LinuxPerformanceObject"
  | "LinuxPerformanceCollection"
  | "CustomLog"
  | "CustomLogCollection"
  | "AzureActivityLog"
  | "GenericDataSource"
  | (string & {});

export interface DataSourceProps {
  /**
   * Resource group of the workspace.
   *
   * :::caution
   * Changing it replaces the data source.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the workspace that holds the data source, e.g.
   * `logs.workspaceName`.
   *
   * :::caution
   * Changing it replaces the data source.
   * :::
   */
  workspace: string;
  /**
   * Data source name: letters, digits, hyphens, and underscores, unique in
   * the workspace.
   *
   * :::caution
   * Changing it replaces the data source.
   * :::
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Kind of data source, e.g. `WindowsEvent` or `LinuxSyslog`.
   *
   * :::caution
   * Changing it replaces the data source.
   * :::
   */
  kind: DataSourceKind;
  /**
   * Kind-specific settings, e.g. for `WindowsEvent`:
   * `{ eventLogName: "System", eventTypes: [{ eventType: "Error" }] }`.
   * Alchemy updates them in place.
   */
  properties: Record<string, unknown>;
}

export interface DataSource extends Resource<
  "Azure.LogAnalytics.DataSource",
  DataSourceProps,
  {
    /** Name of the data source. */
    dataSourceName: string;
    /** Name of the workspace that holds the data source. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** ARM resource ID of the data source. */
    dataSourceId: string;
    /** Kind of data source, e.g. `WindowsEvent`. */
    kind: string;
    /** ETag of the data source. */
    etag: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A data source of a Log Analytics workspace
 * (`Microsoft.OperationalInsights/workspaces/dataSources`): what the legacy
 * Log Analytics agent collects, such as Windows event logs, performance
 * counters, Syslog, custom logs, and IIS logs.
 *
 * :::caution[Changing `name`, `kind`, `workspace`, or `resourceGroup` replaces the data source]
 * Alchemy deletes the old data source before it creates the new one,
 * because settings such as a Windows event log name are unique in the
 * workspace. The agents collect nothing for that source in between.
 * :::
 *
 * :::caution[The Log Analytics agent is retired]
 * Microsoft retired the Log Analytics agent in August 2024. Data sources
 * only affect machines that still run it. For new collection, use data
 * collection rules with the Azure Monitor agent.
 * :::
 *
 * Azure drops tags on data sources, so Alchemy treats a data source as
 * owned when its workspace is owned by the current stack and stage.
 *
 * @see https://learn.microsoft.com/azure/azure-monitor/agents/agent-data-sources
 *
 * ### Collecting Windows Events
 * **Example:** System log errors and warnings
 * ```typescript
 * const logs = yield* Azure.LogAnalytics.Workspace("logs");
 * yield* Azure.LogAnalytics.DataSource("system-events", {
 *   workspace: logs.workspaceName,
 *   kind: "WindowsEvent",
 *   properties: {
 *     eventLogName: "System",
 *     eventTypes: [{ eventType: "Error" }, { eventType: "Warning" }],
 *   },
 * });
 * ```
 *
 * ### Collecting Performance Counters
 * **Example:** CPU every 60 seconds
 * ```typescript
 * const logs = yield* Azure.LogAnalytics.Workspace("logs");
 * yield* Azure.LogAnalytics.DataSource("cpu", {
 *   workspace: logs.workspaceName,
 *   kind: "WindowsPerformanceCounter",
 *   properties: {
 *     objectName: "Processor",
 *     instanceName: "*",
 *     counterName: "% Processor Time",
 *     intervalSeconds: 60,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const DataSource = GroupedResource<DataSource>("Azure.LogAnalytics.DataSource");

type ObservedDataSource = operationalinsights.GetDataSourceResponse;

const getDataSource = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  dataSourceName: string,
) =>
  orUndefinedIfNotFound(
    operationalinsights.GetDataSource({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      dataSourceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  name: string,
  source: ObservedDataSource,
): DataSource["Attributes"] => ({
  dataSourceName: name,
  workspace,
  resourceGroup,
  dataSourceId: source.id ?? "",
  kind: source.kind,
  etag: source.etag,
});

/**
 * Whether every desired value is present in the observed value. Azure
 * fills in defaults the user did not set, so extra observed keys are not
 * a difference.
 */
const contains = (observed: unknown, desired: unknown): boolean => {
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      observed.length === desired.length &&
      desired.every((value, i) => contains(observed[i], value))
    );
  }
  if (desired !== null && typeof desired === "object") {
    return (
      observed !== null &&
      typeof observed === "object" &&
      Object.entries(desired).every(
        ([key, value]) =>
          value === undefined || contains((observed as Record<string, unknown>)[key], value),
      )
    );
  }
  return observed === desired;
};

export const DataSourceProvider = () =>
  Provider.succeed(DataSource, {
    stables: ["dataSourceName", "workspace", "resourceGroup", "dataSourceId"],

    // Data sources live inside a workspace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.workspace, output.workspace) ||
        (news.name !== undefined && !sameText(news.name, output.dataSourceName)) ||
        !sameText(news.kind, output.kind)
      ) {
        // Settings such as a Windows event log name are unique per
        // workspace, so the old source must go before its replacement.
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
      const name = output?.dataSourceName ?? olds?.name ?? (yield* createLogAnalyticsName(id, 63));
      const observed = yield* getDataSource(subscriptionId, resourceGroup, workspace, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, name, observed);
      return (yield* isWorkspaceOwnedByStack(subscriptionId, resourceGroup, workspace))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.OperationalInsights");
      const { resourceGroup, workspace } = news;
      const name = news.name ?? output?.dataSourceName ?? (yield* createLogAnalyticsName(id, 63));

      // Observe.
      let observed = yield* getDataSource(subscriptionId, resourceGroup, workspace, name);

      // Ensure + sync: the PUT is a synchronous upsert of the whole source.
      if (observed === undefined || !contains(observed.properties, news.properties)) {
        observed = yield* operationalinsights.DataSourcesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          dataSourceName: name,
          kind: news.kind,
          properties: news.properties,
          etag: observed?.etag,
        });
      }

      return toAttrs(resourceGroup, workspace, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        operationalinsights.DeleteDataSource({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          dataSourceName: output.dataSourceName,
        }),
      );
      yield* waitUntilGone(
        `data source ${output.dataSourceName}`,
        getDataSource(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.dataSourceName,
        ),
      );
    }),
  });
