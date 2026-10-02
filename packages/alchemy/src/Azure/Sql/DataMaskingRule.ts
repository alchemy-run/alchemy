import * as sql from "@distilled.cloud/azure/sql";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  requireSinglePage,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createChildName, fieldsMatch, lower } from "./common.ts";
import { databasePath, type DatabaseScope } from "./setting.ts";

/** Rules live under the database's singleton masking policy. */
const POLICY_NAME = "Default";

export interface DataMaskingRuleProps {
  /** Resource group of the server. Changing it replaces the rule. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the rule. */
  server: string;
  /** Name of the database. Changing it replaces the rule. */
  database: string;
  /**
   * Rule name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the rule.
   */
  name?: string;
  /** Schema of the masked column, e.g. `dbo`. */
  schemaName: string;
  /** Table of the masked column. */
  tableName: string;
  /** Masked column. The column must exist. */
  columnName: string;
  /**
   * Masking function: `Default` (full mask), `Email`, `CCN` (credit
   * card), `SSN`, `Number` (random number in `numberFrom`..`numberTo`),
   * or `Text` (custom string with `prefixSize`, `replacementString`,
   * `suffixSize`).
   */
  maskingFunction: "Default" | "CCN" | "Email" | "Number" | "SSN" | "Text";
  /** Lower bound of the random number (`Number` only). */
  numberFrom?: string;
  /** Upper bound of the random number (`Number` only). */
  numberTo?: string;
  /** Characters exposed at the start (`Text` only). */
  prefixSize?: string;
  /** Characters exposed at the end (`Text` only). */
  suffixSize?: string;
  /** Padding string that replaces the masked middle (`Text` only). */
  replacementString?: string;
}

export interface DataMaskingRule extends Resource<
  "Azure.Sql.DataMaskingRule",
  DataMaskingRuleProps,
  {
    /** Name of the rule. */
    dataMaskingRuleName: string;
    /** ARM resource ID of the rule. */
    dataMaskingRuleId: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Name of the database. */
    databaseName: string;
    /** Masked column as `schema.table.column`. */
    column: string;
    /** Masking function. */
    maskingFunction: string;
    /** Observed rule state. */
    ruleState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A dynamic data masking rule on one column of an Azure SQL database —
 * non-exempt users see masked values (e.g. `aXXX@XXXX.com`) instead of
 * the real data. Masking only applies while the database's
 * `Azure.Sql.DataMaskingPolicy` is enabled.
 *
 * Azure has no API to delete a rule; destroying the resource disables it
 * (`ruleState: Disabled`), which removes the mask.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/dynamic-data-masking-overview
 *
 * ### Masking Columns
 * **Example:** Mask email addresses
 * ```typescript
 * yield* Azure.Sql.DataMaskingPolicy("masking", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   database: database.databaseName,
 *   dataMaskingState: "Enabled",
 * });
 * yield* Azure.Sql.DataMaskingRule("mask-email", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   database: database.databaseName,
 *   schemaName: "SalesLT",
 *   tableName: "Customer",
 *   columnName: "EmailAddress",
 *   maskingFunction: "Email",
 * });
 * ```
 *
 * **Example:** Show only the last four digits
 * ```typescript
 * yield* Azure.Sql.DataMaskingRule("mask-phone", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   database: database.databaseName,
 *   schemaName: "SalesLT",
 *   tableName: "Customer",
 *   columnName: "Phone",
 *   maskingFunction: "Text",
 *   prefixSize: "0",
 *   replacementString: "xxx-xxx-",
 *   suffixSize: "4",
 * });
 * ```
 *
 * @resource
 */
export const DataMaskingRule = Resource<DataMaskingRule>(
  "Azure.Sql.DataMaskingRule",
);

type Observed = sql.DataMaskingRule;

/** Rules have no GET; find the enabled rule by name in the list. */
const getRule = (subscriptionId: string, scope: DatabaseScope, name: string) =>
  orUndefinedIfNotFound(
    sql
      .ListDataMaskingRuleByDatabase({
        ...databasePath(subscriptionId, scope),
        dataMaskingPolicyName: POLICY_NAME,
      })
      .pipe(
        Effect.flatMap((page) =>
          requireSinglePage("ListDataMaskingRuleByDatabase", page),
        ),
      ),
  ).pipe(
    Effect.map((page) =>
      (page?.value ?? []).find(
        (rule) =>
          lower(rule.name) === lower(name) &&
          lower(rule.properties?.ruleState) !== "disabled",
      ),
    ),
  );

const toAttrs = (
  scope: DatabaseScope,
  name: string,
  rule: Observed,
): DataMaskingRule["Attributes"] => ({
  dataMaskingRuleName: name,
  dataMaskingRuleId: rule.id ?? "",
  resourceGroup: scope.resourceGroup,
  serverName: scope.serverName,
  databaseName: scope.databaseName,
  column: `${rule.properties?.schemaName}.${rule.properties?.tableName}.${rule.properties?.columnName}`,
  maskingFunction: rule.properties?.maskingFunction ?? "",
  ruleState: rule.properties?.ruleState,
});

const desiredOf = (news: DataMaskingRuleProps) => ({
  schemaName: news.schemaName,
  tableName: news.tableName,
  columnName: news.columnName,
  maskingFunction: news.maskingFunction,
  numberFrom: news.numberFrom,
  numberTo: news.numberTo,
  prefixSize: news.prefixSize,
  suffixSize: news.suffixSize,
  replacementString: news.replacementString,
});

export const DataMaskingRuleProvider = () =>
  Provider.succeed(DataMaskingRule, {
    stables: [
      "dataMaskingRuleName",
      "dataMaskingRuleId",
      "resourceGroup",
      "serverName",
      "databaseName",
    ],

    // Rules live inside a database; they are removed with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.server) !== lower(output.serverName) ||
        lower(news.database) !== lower(output.databaseName) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.dataMaskingRuleName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serverName = output?.serverName ?? olds?.server;
      const databaseName = output?.databaseName ?? olds?.database;
      if (
        resourceGroup === undefined ||
        serverName === undefined ||
        databaseName === undefined
      ) {
        return undefined;
      }
      const scope = { resourceGroup, serverName, databaseName };
      const generated = yield* createChildName(id);
      const name = output?.dataMaskingRuleName ?? olds?.name ?? generated;
      const observed = yield* getRule(subscriptionId, scope, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, name, observed);
      return output !== undefined || name === generated
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const scope: DatabaseScope = {
        resourceGroup: news.resourceGroup,
        serverName: news.server,
        databaseName: news.database,
      };
      const name =
        news.name ??
        output?.dataMaskingRuleName ??
        (yield* createChildName(id));
      const desired = desiredOf(news);
      const get = getRule(subscriptionId, scope, name);

      // Observe; the PUT is an upsert, so write only on drift.
      const observed = yield* get;
      if (
        observed === undefined ||
        !fieldsMatch(observed.properties, desired)
      ) {
        yield* sql.DataMaskingRulesCreateOrUpdate({
          ...databasePath(subscriptionId, scope),
          dataMaskingPolicyName: POLICY_NAME,
          dataMaskingRuleName: name,
          properties: { ...desired, ruleState: "Enabled" },
        });
      }
      const fresh = yield* waitForProvisioned(
        `sql data masking rule ${name}`,
        get,
        (rule) =>
          fieldsMatch(rule.properties, desired) ? "Succeeded" : "Updating",
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(scope, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const observed = yield* getRule(
        subscriptionId,
        output,
        output.dataMaskingRuleName,
      );
      if (observed?.properties === undefined) return;
      // Rules cannot be deleted; disabling one removes the mask.
      yield* ignoreNotFound(
        sql.DataMaskingRulesCreateOrUpdate({
          ...databasePath(subscriptionId, output),
          dataMaskingPolicyName: POLICY_NAME,
          dataMaskingRuleName: output.dataMaskingRuleName,
          properties: {
            schemaName: observed.properties.schemaName,
            tableName: observed.properties.tableName,
            columnName: observed.properties.columnName,
            maskingFunction: observed.properties.maskingFunction,
            ruleState: "Disabled",
          },
        }),
      );
      yield* waitUntilGone(
        `sql data masking rule ${output.dataMaskingRuleName}`,
        getRule(subscriptionId, output, output.dataMaskingRuleName),
      );
    }),
  });
