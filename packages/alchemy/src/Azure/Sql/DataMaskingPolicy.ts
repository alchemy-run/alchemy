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
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { fieldsMatch, isServerOwnedByStack, lower } from "./common.ts";
import { databasePath, type DatabaseScope, syncSetting } from "./setting.ts";

/** The policy is a singleton named `Default`. */
const SETTING_NAME = "Default";

export interface DataMaskingPolicyProps {
  /** Resource group of the server. Changing it replaces the policy. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the policy. */
  server: string;
  /** Name of the database. Changing it replaces the policy. */
  database: string;
  /** Whether dynamic data masking is enabled for the database. */
  dataMaskingState: "Enabled" | "Disabled";
  /**
   * Semicolon-separated SQL users that see unmasked data, e.g.
   * `"reporting;dbo"`.
   */
  exemptPrincipals?: string;
}

export interface DataMaskingPolicy extends Resource<
  "Azure.Sql.DataMaskingPolicy",
  DataMaskingPolicyProps,
  {
    /** ARM resource ID of the policy. */
    policyId: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Name of the database. */
    databaseName: string;
    /** Whether data masking is enabled. */
    dataMaskingState: string;
    /** Users that see unmasked data. */
    exemptPrincipals: string | undefined;
    /** Masking level reported by Azure. */
    maskingLevel: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The dynamic data masking policy of an Azure SQL database — turns
 * masking on or off and lists users that always see unmasked data. Add
 * per-column rules with `Azure.Sql.DataMaskingRule`; Azure keeps
 * reporting the policy as `Disabled` until the database has at least one
 * rule.
 *
 * This is a singleton setting that always exists on a database.
 * Destroying the resource disables masking again.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/dynamic-data-masking-overview
 *
 * ### Enabling Masking
 * **Example:** Mask data for everyone but the reporting user
 * ```typescript
 * yield* Azure.Sql.DataMaskingPolicy("masking", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   database: database.databaseName,
 *   dataMaskingState: "Enabled",
 *   exemptPrincipals: "reporting",
 * });
 * ```
 *
 * @resource
 */
export const DataMaskingPolicy = Resource<DataMaskingPolicy>(
  "Azure.Sql.DataMaskingPolicy",
);

type Observed = sql.GetDataMaskingPolicyResponse;

const getSetting = (subscriptionId: string, scope: DatabaseScope) =>
  orUndefinedIfNotFound(
    sql.GetDataMaskingPolicy({
      ...databasePath(subscriptionId, scope),
      dataMaskingPolicyName: SETTING_NAME,
    }),
  );

const toAttrs = (
  scope: DatabaseScope,
  observed: Observed,
): DataMaskingPolicy["Attributes"] => ({
  policyId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  serverName: scope.serverName,
  databaseName: scope.databaseName,
  dataMaskingState: observed.properties?.dataMaskingState ?? "Disabled",
  exemptPrincipals: observed.properties?.exemptPrincipals || undefined,
  maskingLevel: observed.properties?.maskingLevel,
});

export const DataMaskingPolicyProvider = () =>
  Provider.succeed(DataMaskingPolicy, {
    stables: ["policyId", "resourceGroup", "serverName", "databaseName"],

    // A singleton setting of its database; it disappears with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.server) !== lower(output.serverName) ||
        lower(news.database) !== lower(output.databaseName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
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
      const observed = yield* getSetting(subscriptionId, scope);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, observed);
      return output !== undefined ||
        (yield* isServerOwnedByStack(
          subscriptionId,
          scope.resourceGroup,
          scope.serverName,
        ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const scope: DatabaseScope = {
        resourceGroup: news.resourceGroup,
        serverName: news.server,
        databaseName: news.database,
      };
      const desired = {
        dataMaskingState: news.dataMaskingState,
        exemptPrincipals: news.exemptPrincipals ?? "",
      };
      const fresh = yield* syncSetting({
        label: `sql data masking policy on ${scope.databaseName}`,
        get: getSetting(subscriptionId, scope),
        converged: (observed) => fieldsMatch(observed.properties, desired),
        put: sql.DataMaskingPoliciesCreateOrUpdate({
          ...databasePath(subscriptionId, scope),
          dataMaskingPolicyName: SETTING_NAME,
          properties: desired,
        }),
        visible: (observed) =>
          fieldsMatch(observed.properties, desired, ["dataMaskingState"]) &&
          (lower(observed.properties?.dataMaskingState) ===
            lower(desired.dataMaskingState) ||
            desired.dataMaskingState === "Enabled"),
      });
      return toAttrs(scope, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const label = `sql data masking policy on ${output.databaseName}`;
      if ((yield* getSetting(subscriptionId, output)) === undefined) return;
      // The policy cannot be removed; disable masking.
      yield* ignoreNotFound(
        syncSetting({
          label,
          get: getSetting(subscriptionId, output),
          converged: (observed) =>
            lower(observed.properties?.dataMaskingState) === "disabled",
          put: sql.DataMaskingPoliciesCreateOrUpdate({
            ...databasePath(subscriptionId, output),
            dataMaskingPolicyName: SETTING_NAME,
            properties: { dataMaskingState: "Disabled" },
          }),
        }),
      );
    }),

    nuke: { singleton: true },
  });
