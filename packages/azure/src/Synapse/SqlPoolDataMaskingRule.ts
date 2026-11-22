import * as synapse from "@distilled.cloud/azure/synapse";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ensureRegistered, orUndefinedIfNotFound } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  createAlnumName,
  fieldsMatch,
  isWorkspaceOwnedByStack,
  resetSetting,
  type SqlPoolChildAttrs,
  type SqlPoolChildProps,
  sqlPoolChildMoved,
  sqlPoolChildRef,
  sqlPoolWhere,
  syncSetting,
} from "./common.ts";

/** Rules hang off the pool's singleton masking policy `Default`. */
const POLICY_NAME = "Default";

export interface SqlPoolDataMaskingRuleProps extends SqlPoolChildProps {
  /**
   * Rule name. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the rule.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /** Schema of the masked column. */
  schemaName: string;
  /** Table of the masked column. */
  tableName: string;
  /** Masked column. */
  columnName: string;
  /**
   * Masking function: `Default` (full mask), `CCN` (credit card), `Email`,
   * `Number` (random number), `SSN`, or `Text` (custom string).
   */
  maskingFunction: "Default" | "CCN" | "Email" | "Number" | "SSN" | "Text";
  /**
   * Alias of the masked column.
   * @default not set
   */
  aliasName?: string;
  /**
   * Lower bound of the random number (`Number` masking).
   * @default not set
   */
  numberFrom?: string;
  /**
   * Upper bound of the random number (`Number` masking).
   * @default not set
   */
  numberTo?: string;
  /**
   * Characters exposed at the start (`Text` masking).
   * @default not set
   */
  prefixSize?: string;
  /**
   * Characters exposed at the end (`Text` masking).
   * @default not set
   */
  suffixSize?: string;
  /**
   * Padding string between prefix and suffix (`Text` masking).
   * @default not set
   */
  replacementString?: string;
}

export interface SqlPoolDataMaskingRule extends Resource<
  "Azure.Synapse.SqlPoolDataMaskingRule",
  SqlPoolDataMaskingRuleProps,
  SqlPoolChildAttrs & {
    /** Name of the rule. */
    ruleName: string;
    /** ARM resource ID of the rule. */
    ruleId: string;
    /** `Enabled`, or `Disabled` after the rule was destroyed. */
    ruleState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A dynamic data masking rule on a column of a dedicated SQL pool
 * (`Microsoft.Synapse/workspaces/sqlPools/dataMaskingPolicies/rules`). The
 * column must exist (create the table first) and the pool's masking policy
 * (`Azure.Synapse.SqlPoolDataMaskingPolicy`) must be enabled. The pool must
 * be online.
 *
 * ARM cannot delete masking rules, so destroying the resource disables the
 * rule instead.
 *
 * :::caution
 * Changing `workspace`, `sqlPool`, `name`, or `resourceGroup` replaces the
 * rule.
 * :::
 *
 * :::caution
 * Create the table with T-SQL before you deploy the rule: the column must
 * exist.
 * :::
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/dynamic-data-masking-overview
 *
 * ### Masking Columns
 * **Example:** Mask email addresses
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
 * const masking = yield* Azure.Synapse.SqlPoolDataMaskingPolicy("masking", {
 *   workspace: workspace.workspaceName,
 *   sqlPool: pool.sqlPoolName,
 * });
 * yield* Azure.Synapse.SqlPoolDataMaskingRule("email", {
 *   workspace: workspace.workspaceName,
 *   sqlPool: masking.sqlPoolName,
 *   schemaName: "dbo",
 *   tableName: "customers",
 *   columnName: "email",
 *   maskingFunction: "Email",
 * });
 * ```
 *
 * **Example:** Show only the last four digits
 * ```typescript
 * yield* Azure.Synapse.SqlPoolDataMaskingRule("phone", {
 *   workspace: workspace.workspaceName,
 *   sqlPool: masking.sqlPoolName,
 *   schemaName: "dbo",
 *   tableName: "customers",
 *   columnName: "phone",
 *   maskingFunction: "Text",
 *   prefixSize: "0",
 *   suffixSize: "4",
 *   replacementString: "xxx-xxx-",
 * });
 * ```
 *
 * @resource
 */
export const SqlPoolDataMaskingRule = GroupedResource<SqlPoolDataMaskingRule>(
  "Azure.Synapse.SqlPoolDataMaskingRule",
);

type Observed = synapse.GetDataMaskingRuleResponse;

const createRuleName = (id: string) => createAlnumName(id, 60);

const getRule = (subscriptionId: string, ref: SqlPoolChildAttrs, dataMaskingRuleName: string) =>
  orUndefinedIfNotFound(
    synapse.GetDataMaskingRule({
      ...sqlPoolWhere(subscriptionId, ref),
      dataMaskingPolicyName: POLICY_NAME,
      dataMaskingRuleName,
    }),
  );

const toAttrs = (
  ref: SqlPoolChildAttrs,
  name: string,
  rule: Observed,
): SqlPoolDataMaskingRule["Attributes"] => ({
  ...ref,
  ruleName: name,
  ruleId: rule.id ?? "",
  ruleState: rule.properties?.ruleState,
});

const ruleSync = (
  subscriptionId: string,
  ref: SqlPoolChildAttrs,
  name: string,
  desired: synapse.DataMaskingRulePropertiesInput,
) => ({
  label: `synapse data masking rule ${name}`,
  get: getRule(subscriptionId, ref, name),
  matches: (rule: Observed) => fieldsMatch(rule.properties, desired),
  put: synapse.DataMaskingRulesCreateOrUpdate({
    ...sqlPoolWhere(subscriptionId, ref),
    dataMaskingPolicyName: POLICY_NAME,
    dataMaskingRuleName: name,
    properties: desired,
  }),
});

export const SqlPoolDataMaskingRuleProvider = () =>
  Provider.succeed(SqlPoolDataMaskingRule, {
    stables: ["ruleName", "ruleId", "workspaceName", "resourceGroup", "sqlPoolName"],

    // Rules live inside a SQL pool and cannot be deleted.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        sqlPoolChildMoved(news, output) ||
        (news.name !== undefined && news.name !== output.ruleName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const ref = sqlPoolChildRef(olds, output);
      if (ref === undefined) return undefined;
      const name = output?.ruleName ?? olds?.name ?? (yield* createRuleName(id));
      const observed = yield* getRule(subscriptionId, ref, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(ref, name, observed);
      return output !== undefined ||
        (yield* isWorkspaceOwnedByStack(subscriptionId, ref.resourceGroup, ref.workspaceName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Synapse");
      const ref = {
        resourceGroup: news.resourceGroup,
        workspaceName: news.workspace,
        sqlPoolName: news.sqlPool,
      };
      const name = news.name ?? output?.ruleName ?? (yield* createRuleName(id));
      const fresh = yield* syncSetting(
        ruleSync(subscriptionId, ref, name, {
          ruleState: "Enabled",
          schemaName: news.schemaName,
          tableName: news.tableName,
          columnName: news.columnName,
          maskingFunction: news.maskingFunction,
          aliasName: news.aliasName,
          numberFrom: news.numberFrom,
          numberTo: news.numberTo,
          prefixSize: news.prefixSize,
          suffixSize: news.suffixSize,
          replacementString: news.replacementString,
        }),
      );
      return toAttrs(ref, name, fresh);
    }),

    delete: Effect.fn(function* ({ output, olds }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const ref = {
        resourceGroup: output.resourceGroup,
        workspaceName: output.workspaceName,
        sqlPoolName: output.sqlPoolName,
      };
      // ARM has no delete for masking rules; disable the rule instead.
      const observed = yield* getRule(subscriptionId, ref, output.ruleName);
      const props = observed?.properties;
      if (props === undefined) return;
      yield* resetSetting(
        ruleSync(subscriptionId, ref, output.ruleName, {
          ruleState: "Disabled",
          schemaName: props.schemaName ?? olds?.schemaName,
          tableName: props.tableName ?? olds?.tableName,
          columnName: props.columnName ?? olds?.columnName,
          maskingFunction: props.maskingFunction ?? olds?.maskingFunction,
        }),
      );
    }),

    nuke: { skip: true },
  });
