import * as operationalinsights from "@distilled.cloud/azure/operationalinsights";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { ownershipMarker, sameText, stripMarker, withMarker } from "./Common.ts";

/**
 * Table plan: `Analytics` (full KQL, alerts, interactive retention),
 * `Basic` (cheaper ingestion, limited KQL, 30-day interactive retention),
 * or `Auxiliary` (lowest cost, for verbose logs you rarely query).
 */
export type TablePlan = "Analytics" | "Basic" | "Auxiliary";

/** Data type of a custom table column. */
export type TableColumnType =
  | "string"
  | "int"
  | "long"
  | "real"
  | "boolean"
  | "dateTime"
  | "guid"
  | "dynamic";

/** One column of a custom table. */
export interface TableColumn {
  /** Column name: letters, digits, and underscores, starting with a letter. */
  name: string;
  /**
   * Column data type: `string`, `int`, `long`, `real`, `boolean`,
   * `dateTime`, `guid`, or `dynamic` (JSON).
   *
   * :::caution
   * Changing it replaces the table and deletes its data.
   * :::
   */
  type: TableColumnType;
  /**
   * Logical hint for a `string` column: `uri`, `guid`, `armPath`, or `ip`.
   * @default no hint
   */
  dataTypeHint?: "uri" | "guid" | "armPath" | "ip";
  /**
   * Column description. Alchemy updates it in place.
   * @default no description
   */
  description?: string;
  /**
   * Column display name. Azure accepts it only when the column is created.
   * @default the column name
   */
  displayName?: string;
}

export interface TableProps {
  /**
   * Resource group of the workspace.
   *
   * :::caution
   * Changing it replaces the table and deletes its data.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the workspace that holds the table, e.g. `logs.workspaceName`.
   *
   * :::caution
   * Changing it replaces the table and deletes its data.
   * :::
   */
  workspace: string;
  /**
   * Table name: letters, digits, and underscores, ending in `_CL`
   * (custom tables), e.g. `AppEvents_CL`.
   *
   * :::caution
   * Changing it replaces the table and deletes its data.
   * :::
   * @default a name ending in `_CL`, generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Columns of the table. Include `TimeGenerated` of type `dateTime`.
   * Alchemy adds new columns in place.
   *
   * :::caution
   * Removing a column or changing its `type` replaces the table and deletes
   * its data.
   * :::
   */
  columns: TableColumn[];
  /**
   * Table plan: `Analytics`, `Basic`, or `Auxiliary`. Azure lets you switch
   * between `Analytics` and `Basic` once a week, in place.
   *
   * :::caution
   * Moving to or from `Auxiliary` replaces the table and deletes its data.
   * :::
   * @default "Analytics"
   */
  plan?: TablePlan;
  /**
   * Interactive retention in days: 4-730, or `-1` for the workspace
   * retention. Only the `Analytics` plan uses it.
   * @default -1
   */
  retentionInDays?: number;
  /**
   * Total retention in days, including long-term retention: 4-4383, or `-1`
   * for the interactive retention.
   * @default -1
   */
  totalRetentionInDays?: number;
  /**
   * Table description. Alchemy appends an `[alchemy <stack>/<stage>/<id>]`
   * ownership marker because tables have no tags.
   * @default no description (only the ownership marker)
   */
  description?: string;
  /**
   * Table display name.
   * @default the table name
   */
  displayName?: string;
}

export interface Table extends Resource<
  "Azure.LogAnalytics.Table",
  TableProps,
  {
    /** Name of the table, e.g. `AppEvents_CL`. */
    tableName: string;
    /** Name of the workspace that holds the table. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** ARM resource ID of the table. */
    tableId: string;
    /** Table plan: `Analytics`, `Basic`, or `Auxiliary`. */
    plan: string;
    /** Interactive retention in days. */
    retentionInDays: number | undefined;
    /** Total retention in days, including long-term retention. */
    totalRetentionInDays: number | undefined;
    /** Long-term (archive) retention in days. */
    archiveRetentionInDays: number | undefined;
    /** Kind of table, e.g. `CustomLog` or `Microsoft`. */
    tableType: string | undefined;
    /** User description (Alchemy ownership marker stripped). */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A custom table in a Log Analytics workspace
 * (`Microsoft.OperationalInsights/workspaces/tables`), named `*_CL`. Send
 * rows to it with the Logs Ingestion API (`Azure.Monitor.UploadLogs`), a
 * data collection rule, or a summary rule, and query it with KQL.
 *
 * :::caution[Changing `name`, `workspace`, `resourceGroup`, a column's `type`, removing a column, or moving to or from the `Auxiliary` plan replaces the table]
 * Alchemy deletes the old table, and its data goes with it.
 * :::
 *
 * :::caution[The workspace must exist first]
 * Declare the `Azure.LogAnalytics.Workspace` and pass its `workspaceName`.
 * Deleting the table deletes its data.
 * :::
 *
 * Tables have no tags, so Alchemy records ownership as a marker at the end
 * of the table description.
 *
 * @see https://learn.microsoft.com/azure/azure-monitor/logs/create-custom-table
 *
 * ### Creating a Table
 * **Example:** Custom table
 * ```typescript
 * const logs = yield* Azure.LogAnalytics.Workspace("logs");
 * const events = yield* Azure.LogAnalytics.Table("events", {
 *   workspace: logs.workspaceName,
 *   name: "AppEvents_CL",
 *   columns: [
 *     { name: "TimeGenerated", type: "dateTime" },
 *     { name: "Message", type: "string" },
 *   ],
 * });
 * ```
 *
 * ### Retention and Plans
 * **Example:** Basic-plan table with long-term retention
 * ```typescript
 * const logs = yield* Azure.LogAnalytics.Workspace("logs");
 * const audit = yield* Azure.LogAnalytics.Table("audit", {
 *   workspace: logs.workspaceName,
 *   name: "Audit_CL",
 *   plan: "Basic",
 *   totalRetentionInDays: 365,
 *   columns: [
 *     { name: "TimeGenerated", type: "dateTime" },
 *     { name: "Actor", type: "string" },
 *     { name: "Details", type: "dynamic" },
 *   ],
 * });
 * ```
 *
 * **Example:** Keep 90 days interactive and two years in total
 * ```typescript
 * const events = yield* Azure.LogAnalytics.Table("events", {
 *   workspace: logs.workspaceName,
 *   name: "AppEvents_CL",
 *   retentionInDays: 90,
 *   totalRetentionInDays: 730,
 *   columns: [
 *     { name: "TimeGenerated", type: "dateTime" },
 *     { name: "Message", type: "string" },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const Table = GroupedResource<Table>("Azure.LogAnalytics.Table");

type ObservedTable = operationalinsights.GetTableResponse;

const createTableName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 40,
    delimiter: "_",
  });
  return `${name.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^[^a-zA-Z]+/, "")}_CL`;
});

const getTable = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  tableName: string,
) =>
  orUndefinedIfNotFound(
    operationalinsights.GetTable({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      tableName,
    }),
  ).pipe(
    // A deleted table lingers in `Deleting` until the async delete ends.
    Effect.map((table) =>
      table?.properties?.provisioningState === "Deleting" ? undefined : table,
    ),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  name: string,
  table: ObservedTable,
): Table["Attributes"] => ({
  tableName: name,
  workspace,
  resourceGroup,
  tableId: table.id ?? "",
  plan: table.properties?.plan ?? "Analytics",
  retentionInDays: table.properties?.retentionInDays,
  totalRetentionInDays: table.properties?.totalRetentionInDays,
  archiveRetentionInDays: table.properties?.archiveRetentionInDays,
  tableType: table.properties?.schema?.tableType,
  description: stripMarker(table.properties?.schema?.description),
});

const columnKey = (column: { name?: string; type?: string }) =>
  `${(column.name ?? "").toLowerCase()}:${(column.type ?? "").toLowerCase()}`;

/** Whether the observed table differs from the desired one. */
const tableDiffers = (
  observed: operationalinsights.TableProperties | undefined,
  desired: operationalinsights.TablePropertiesInput,
) => {
  if (!sameText(observed?.plan ?? "Analytics", desired.plan)) return true;
  const retention = observed?.retentionInDaysAsDefault ? -1 : observed?.retentionInDays;
  if (desired.plan === "Analytics" && retention !== desired.retentionInDays) {
    return true;
  }
  const total = observed?.totalRetentionInDaysAsDefault ? -1 : observed?.totalRetentionInDays;
  if (total !== desired.totalRetentionInDays) return true;
  const schema = observed?.schema;
  if ((schema?.description ?? "") !== (desired.schema?.description ?? "")) {
    return true;
  }
  if (
    desired.schema?.displayName !== undefined &&
    schema?.displayName !== desired.schema.displayName
  ) {
    return true;
  }
  const have = new Map((schema?.columns ?? []).map((column) => [columnKey(column), column]));
  return (desired.schema?.columns ?? []).some((column) => {
    const match = have.get(columnKey(column));
    return (
      match === undefined ||
      (column.description !== undefined && (match.description ?? "") !== column.description)
    );
  });
};

export const TableProvider = () =>
  Provider.succeed(Table, {
    stables: ["tableName", "workspace", "resourceGroup", "tableId"],

    // Tables live inside a workspace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.workspace, output.workspace) ||
        (news.name !== undefined && !sameText(news.name, output.tableName))
      ) {
        return { action: "replace" } as const;
      }
      const newPlan = news.plan ?? "Analytics";
      if (newPlan !== output.plan && (newPlan === "Auxiliary" || output.plan === "Auxiliary")) {
        return { action: "replace" } as const;
      }
      // Removing a column or changing its type cannot be done in place.
      const desired = new Set(news.columns.map(columnKey));
      if ((olds?.columns ?? []).some((column) => !desired.has(columnKey(column)))) {
        return { action: "replace" } as const;
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
      const name = output?.tableName ?? olds?.name ?? (yield* createTableName(id));
      const observed = yield* getTable(subscriptionId, resourceGroup, workspace, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, name, observed);
      const marker = yield* ownershipMarker(id);
      return (observed.properties?.schema?.description ?? "").endsWith(marker)
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.OperationalInsights");
      const { resourceGroup, workspace } = news;
      const name = news.name ?? output?.tableName ?? (yield* createTableName(id));
      const plan = news.plan ?? "Analytics";
      const properties: operationalinsights.TablePropertiesInput = {
        plan,
        retentionInDays: plan === "Analytics" ? (news.retentionInDays ?? -1) : undefined,
        totalRetentionInDays: news.totalRetentionInDays ?? -1,
        schema: {
          name,
          displayName: news.displayName,
          description: withMarker(news.description, yield* ownershipMarker(id)),
          columns: news.columns.map((column) => ({
            name: column.name,
            type: column.type,
            dataTypeHint: column.dataTypeHint,
            description: column.description,
            displayName: column.displayName,
          })),
        },
      };
      const get = getTable(subscriptionId, resourceGroup, workspace, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the PUT carries the full schema, so one call creates
      // the table or converges plan, retention, and columns.
      if (observed === undefined || tableDiffers(observed.properties, properties)) {
        yield* operationalinsights.TablesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          tableName: name,
          properties,
        });
      }

      const fresh = yield* waitForProvisioned(
        `Log Analytics table ${name}`,
        get,
        (table) =>
          table.properties?.provisioningState === "InProgress" ||
          table.properties?.provisioningState === "Updating"
            ? "Updating"
            : "Succeeded",
        { interval: "3 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, workspace, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        operationalinsights.DeleteTable({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          tableName: output.tableName,
        }),
      );
      yield* waitUntilGone(
        `Log Analytics table ${output.tableName}`,
        getTable(subscriptionId, output.resourceGroup, output.workspace, output.tableName),
        { interval: "3 seconds", times: 60 },
      );
    }),
  });
