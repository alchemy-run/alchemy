import * as sql from "@distilled.cloud/azure/sql";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound, waitUntilGone } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { isManagedInstanceOwnedByStack, lower } from "./common.ts";
import { managedDatabasePath, type ManagedDatabaseScope, syncSetting } from "./setting.ts";

/** Labels set by users (as opposed to the classification engine's `recommended`). */
const LABEL_SOURCE = "current";

export interface ManagedDatabaseSensitivityLabelProps {
  /** Resource group of the managed instance. Changing it replaces the label. */
  resourceGroup: string;
  /** Name of the managed instance. Changing it replaces the label. */
  managedInstance: string;
  /** Name of the database. Changing it replaces the label. */
  database: string;
  /** Schema of the table, e.g. `dbo`. Changing it replaces the label. */
  schema: string;
  /** Table that holds the column. Changing it replaces the label. */
  table: string;
  /** Column to classify. Changing it replaces the label. */
  column: string;
  /**
   * Sensitivity label from the information protection policy, e.g.
   * `Public`, `General`, `Confidential`, `Confidential - GDPR`,
   * `Highly Confidential`.
   */
  labelName?: string;
  /** ID of the sensitivity label in the information protection policy. */
  labelId?: string;
  /**
   * Information type, e.g. `Contact Info`, `Name`, `Credentials`,
   * `Financial`, `National ID`.
   */
  informationType?: string;
  /** ID of the information type in the information protection policy. */
  informationTypeId?: string;
  /**
   * Sensitivity rank of the column.
   * @default "None"
   */
  rank?: sql.SensitivityLabelRank;
}

export interface ManagedDatabaseSensitivityLabel extends Resource<
  "Azure.Sql.ManagedDatabaseSensitivityLabel",
  ManagedDatabaseSensitivityLabelProps,
  {
    /** ARM resource ID of the label. */
    sensitivityLabelId: string;
    /** Resource group of the managed instance. */
    resourceGroup: string;
    /** Name of the managed instance. */
    managedInstanceName: string;
    /** Name of the database. */
    databaseName: string;
    /** Schema of the table. */
    schemaName: string;
    /** Table that holds the column. */
    tableName: string;
    /** Classified column. */
    columnName: string;
    /** Observed label name. */
    labelName: string | undefined;
    /** Observed information type. */
    informationType: string | undefined;
    /** Observed rank. */
    rank: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A data classification (sensitivity label) on one column of a database in
 * an Azure SQL Managed Instance
 * (`Microsoft.Sql/managedInstances/databases/schemas/tables/columns/sensitivityLabels`).
 * Auditing records the label of every column a query returns, and the
 * Data Discovery & Classification dashboard reports it. For Azure SQL
 * Database, use {@link SensitivityLabel}.
 *
 * The schema, table, and column must already exist in the database (create
 * them with T-SQL or a migration). Alchemy writes the `current` label;
 * recommendations of the classification engine are not managed.
 *
 * :::caution
 * Changing `resourceGroup`, `managedInstance`, `database`, `schema`,
 * `table`, or `column` replaces the label.
 * :::
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/data-discovery-and-classification-overview
 *
 * ### Classifying Columns
 * **Example:** Label an e-mail column as confidential contact info
 * ```typescript
 * yield* Azure.Sql.ManagedDatabaseSensitivityLabel("customer-email", {
 *   managedInstance: instance.managedInstanceName,
 *   database: database.databaseName,
 *   schema: "dbo",
 *   table: "Customer",
 *   column: "EmailAddress",
 *   labelName: "Confidential",
 *   informationType: "Contact Info",
 *   rank: "Medium",
 * });
 * ```
 *
 * @resource
 */
export const ManagedDatabaseSensitivityLabel = GroupedResource<ManagedDatabaseSensitivityLabel>(
  "Azure.Sql.ManagedDatabaseSensitivityLabel",
);

interface ColumnScope extends ManagedDatabaseScope {
  schemaName: string;
  tableName: string;
  columnName: string;
}

const labelPath = (subscriptionId: string, scope: ColumnScope) => ({
  ...managedDatabasePath(subscriptionId, scope),
  schemaName: scope.schemaName,
  tableName: scope.tableName,
  columnName: scope.columnName,
  sensitivityLabelSource: LABEL_SOURCE,
});

const getLabel = (subscriptionId: string, scope: ColumnScope) =>
  orUndefinedIfNotFound(sql.GetManagedDatabaseSensitivityLabel(labelPath(subscriptionId, scope)));

type Observed = sql.GetManagedDatabaseSensitivityLabelResponse;

const toAttrs = (
  scope: ColumnScope,
  observed: Observed,
): ManagedDatabaseSensitivityLabel["Attributes"] => ({
  sensitivityLabelId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  managedInstanceName: scope.managedInstanceName,
  databaseName: scope.databaseName,
  schemaName: scope.schemaName,
  tableName: scope.tableName,
  columnName: scope.columnName,
  labelName: observed.properties?.labelName,
  informationType: observed.properties?.informationType,
  rank: observed.properties?.rank,
});

/** Whether every specified field matches the observed label. */
const matches = (observed: Observed, desired: sql.SensitivityLabelPropertiesInput) => {
  const p = observed.properties;
  return (
    (desired.labelName === undefined || lower(p?.labelName) === lower(desired.labelName)) &&
    (desired.labelId === undefined || lower(p?.labelId) === lower(desired.labelId)) &&
    (desired.informationType === undefined ||
      lower(p?.informationType) === lower(desired.informationType)) &&
    (desired.informationTypeId === undefined ||
      lower(p?.informationTypeId) === lower(desired.informationTypeId)) &&
    lower(p?.rank ?? "None") === lower(desired.rank ?? "None")
  );
};

export const ManagedDatabaseSensitivityLabelProvider = () =>
  Provider.succeed(ManagedDatabaseSensitivityLabel, {
    stables: [
      "sensitivityLabelId",
      "resourceGroup",
      "managedInstanceName",
      "databaseName",
      "schemaName",
      "tableName",
      "columnName",
    ],

    // Labels live inside a managed database; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.managedInstance) !== lower(output.managedInstanceName) ||
        lower(news.database) !== lower(output.databaseName) ||
        lower(news.schema) !== lower(output.schemaName) ||
        lower(news.table) !== lower(output.tableName) ||
        lower(news.column) !== lower(output.columnName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const managedInstanceName = output?.managedInstanceName ?? olds?.managedInstance;
      const databaseName = output?.databaseName ?? olds?.database;
      const schemaName = output?.schemaName ?? olds?.schema;
      const tableName = output?.tableName ?? olds?.table;
      const columnName = output?.columnName ?? olds?.column;
      if (
        resourceGroup === undefined ||
        managedInstanceName === undefined ||
        databaseName === undefined ||
        schemaName === undefined ||
        tableName === undefined ||
        columnName === undefined
      ) {
        return undefined;
      }
      const scope: ColumnScope = {
        resourceGroup,
        managedInstanceName,
        databaseName,
        schemaName,
        tableName,
        columnName,
      };
      const observed = yield* getLabel(subscriptionId, scope);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, observed);
      return output !== undefined ||
        (yield* isManagedInstanceOwnedByStack(subscriptionId, resourceGroup, managedInstanceName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const scope: ColumnScope = {
        resourceGroup: news.resourceGroup,
        managedInstanceName: news.managedInstance,
        databaseName: news.database,
        schemaName: news.schema,
        tableName: news.table,
        columnName: news.column,
      };
      const desired: sql.SensitivityLabelPropertiesInput = {
        labelName: news.labelName,
        labelId: news.labelId,
        informationType: news.informationType,
        informationTypeId: news.informationTypeId,
        rank: news.rank ?? "None",
      };
      const fresh = yield* syncSetting({
        label: `sql managed database sensitivity label on ${scope.schemaName}.${scope.tableName}.${scope.columnName}`,
        get: getLabel(subscriptionId, scope),
        converged: (observed) => matches(observed, desired),
        put: sql.ManagedDatabaseSensitivityLabelsCreateOrUpdate({
          ...labelPath(subscriptionId, scope),
          properties: desired,
        }),
        times: 20,
      });
      return toAttrs(scope, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sql.DeleteManagedDatabaseSensitivityLabel(labelPath(subscriptionId, output)),
      );
      yield* waitUntilGone(
        `sql managed database sensitivity label on ${output.schemaName}.${output.tableName}.${output.columnName}`,
        getLabel(subscriptionId, output),
      );
    }),
  });
