import * as synapse from "@distilled.cloud/azure/synapse";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound, waitUntilGone } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  isWorkspaceOwnedByStack,
  lower,
  type SqlPoolChildAttrs,
  sqlPoolChildMoved,
  type SqlPoolChildProps,
  sqlPoolChildRef,
  sqlPoolWhere,
  syncSetting,
} from "./common.ts";

/** Alchemy manages applied labels; `recommended` labels are read-only. */
const LABEL_SOURCE = "current";

export type SqlPoolSensitivityLabelRank = "None" | "Low" | "Medium" | "High" | "Critical";

export interface SqlPoolSensitivityLabelProps extends SqlPoolChildProps {
  /** Schema of the labelled column. Changing it replaces the label. */
  schemaName: string;
  /** Table of the labelled column. Changing it replaces the label. */
  tableName: string;
  /** Labelled column. Changing it replaces the label. */
  columnName: string;
  /**
   * Sensitivity label, e.g. `Confidential` or `Highly Confidential`.
   * @default not set
   */
  labelName?: string;
  /**
   * ID of the sensitivity label in the information protection policy.
   * @default not set
   */
  labelId?: string;
  /**
   * Information type, e.g. `Contact Info`, `Financial`, `Credentials`.
   * @default not set
   */
  informationType?: string;
  /**
   * ID of the information type in the information protection policy.
   * @default not set
   */
  informationTypeId?: string;
  /**
   * Sensitivity rank of the column.
   * @default Azure's rank for the label
   */
  rank?: SqlPoolSensitivityLabelRank;
}

export interface SqlPoolSensitivityLabel extends Resource<
  "Azure.Synapse.SqlPoolSensitivityLabel",
  SqlPoolSensitivityLabelProps,
  SqlPoolChildAttrs & {
    /** ARM resource ID of the label. */
    labelResourceId: string;
    /** Schema of the labelled column. */
    schemaName: string;
    /** Table of the labelled column. */
    tableName: string;
    /** Labelled column. */
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
 * A data classification (sensitivity label) on a column of a dedicated SQL
 * pool (`Microsoft.Synapse/workspaces/sqlPools/schemas/tables/columns/sensit
 * ivityLabels`). Labels feed auditing and Microsoft Purview reports.
 *
 * The column must exist: only T-SQL DDL can create tables, so create the
 * table first. The pool must be online. Destroying the resource removes
 * the label.
 *
 * :::caution
 * Changing `resourceGroup`, `workspace`, `sqlPool`, `schemaName`,
 * `tableName`, or `columnName` replaces the label.
 * :::
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/data-discovery-and-classification-overview
 *
 * ### Classifying Columns
 * **Example:** Label an email column as confidential contact info
 * ```typescript
 * const lake = yield* Azure.Storage.StorageAccount("lake", {
 *   isHnsEnabled: true,
 * });
 * const fs = yield* Azure.Storage.BlobContainer("fs", {
 *   storageAccount: lake.storageAccountName,
 * });
 * const workspace = yield* Azure.Synapse.Workspace("ws", {
 *   defaultDataLakeStorage: {
 *     accountUrl: lake.primaryEndpoints.dfs.as<string>(),
 *     filesystem: fs.containerName,
 *   },
 * });
 * const pool = yield* Azure.Synapse.SqlPool("dw", {
 *   workspace: workspace.workspaceName,
 *   sku: "DW100c",
 * });
 * yield* Azure.Synapse.SqlPoolSensitivityLabel("email-label", {
 *   workspace: workspace.workspaceName,
 *   sqlPool: pool.sqlPoolName,
 *   schemaName: "dbo",
 *   tableName: "customers",
 *   columnName: "email",
 *   labelName: "Confidential",
 *   informationType: "Contact Info",
 *   rank: "Medium",
 * });
 * ```
 *
 * @resource
 */
export const SqlPoolSensitivityLabel = GroupedResource<SqlPoolSensitivityLabel>(
  "Azure.Synapse.SqlPoolSensitivityLabel",
);

interface LabelRef extends SqlPoolChildAttrs {
  schemaName: string;
  tableName: string;
  columnName: string;
}

type Observed = synapse.GetSqlPoolSensitivityLabelResponse;

const labelWhere = (subscriptionId: string, ref: LabelRef) => ({
  ...sqlPoolWhere(subscriptionId, ref),
  schemaName: ref.schemaName,
  tableName: ref.tableName,
  columnName: ref.columnName,
  sensitivityLabelSource: LABEL_SOURCE,
});

const getLabel = (subscriptionId: string, ref: LabelRef) =>
  orUndefinedIfNotFound(synapse.GetSqlPoolSensitivityLabel(labelWhere(subscriptionId, ref))).pipe(
    // A column without a label reads back as an empty shell.
    Effect.map((label) =>
      label?.properties?.labelName || label?.properties?.informationType ? label : undefined,
    ),
  );

const toAttrs = (ref: LabelRef, label: Observed): SqlPoolSensitivityLabel["Attributes"] => ({
  ...ref,
  labelResourceId: label.id ?? "",
  labelName: label.properties?.labelName,
  informationType: label.properties?.informationType,
  rank: label.properties?.rank,
});

/** Whether `observed` reflects every desired field (unset fields are free). */
const matches = (observed: Observed, desired: synapse.SensitivityLabelPropertiesInput) => {
  const props = observed.properties;
  const same = (a: string | undefined, b: string | undefined) =>
    b === undefined || lower(a) === lower(b);
  return (
    same(props?.labelName, desired.labelName) &&
    same(props?.labelId, desired.labelId) &&
    same(props?.informationType, desired.informationType) &&
    same(props?.informationTypeId, desired.informationTypeId) &&
    same(props?.rank, desired.rank)
  );
};

const labelMoved = (news: SqlPoolSensitivityLabelProps, output: LabelRef) =>
  sqlPoolChildMoved(news, output) ||
  lower(news.schemaName) !== lower(output.schemaName) ||
  lower(news.tableName) !== lower(output.tableName) ||
  lower(news.columnName) !== lower(output.columnName);

export const SqlPoolSensitivityLabelProvider = () =>
  Provider.succeed(SqlPoolSensitivityLabel, {
    stables: [
      "labelResourceId",
      "workspaceName",
      "resourceGroup",
      "sqlPoolName",
      "schemaName",
      "tableName",
      "columnName",
    ],

    // Labels live on columns inside a pool; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (labelMoved(news, output)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const pool = sqlPoolChildRef(olds, output);
      const schemaName = output?.schemaName ?? olds?.schemaName;
      const tableName = output?.tableName ?? olds?.tableName;
      const columnName = output?.columnName ?? olds?.columnName;
      if (
        pool === undefined ||
        schemaName === undefined ||
        tableName === undefined ||
        columnName === undefined
      ) {
        return undefined;
      }
      const ref: LabelRef = { ...pool, schemaName, tableName, columnName };
      const observed = yield* getLabel(subscriptionId, ref);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(ref, observed);
      // No tags or markers: ownership follows the workspace.
      return output !== undefined ||
        (yield* isWorkspaceOwnedByStack(subscriptionId, ref.resourceGroup, ref.workspaceName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Synapse");
      const ref: LabelRef = {
        resourceGroup: news.resourceGroup,
        workspaceName: news.workspace,
        sqlPoolName: news.sqlPool,
        schemaName: news.schemaName,
        tableName: news.tableName,
        columnName: news.columnName,
      };
      const desired: synapse.SensitivityLabelPropertiesInput = {
        labelName: news.labelName,
        labelId: news.labelId,
        informationType: news.informationType,
        informationTypeId: news.informationTypeId,
        rank: news.rank,
      };
      const fresh = yield* syncSetting({
        label: `synapse sensitivity label on ${ref.schemaName}.${ref.tableName}.${ref.columnName}`,
        get: getLabel(subscriptionId, ref),
        matches: (observed) => matches(observed, desired),
        put: synapse.SqlPoolSensitivityLabelsCreateOrUpdate({
          ...labelWhere(subscriptionId, ref),
          properties: desired,
        }),
      });
      return toAttrs(ref, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        synapse.DeleteSqlPoolSensitivityLabel(labelWhere(subscriptionId, output)),
      );
      yield* waitUntilGone(
        `synapse sensitivity label on ${output.schemaName}.${output.tableName}.${output.columnName}`,
        getLabel(subscriptionId, output),
        { interval: "5 seconds", times: 24 },
      );
    }),
  });
