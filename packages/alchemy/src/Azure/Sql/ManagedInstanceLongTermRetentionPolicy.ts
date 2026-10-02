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
import { fieldsMatch, isManagedInstanceOwnedByStack, lower } from "./common.ts";
import {
  managedDatabasePath,
  type ManagedDatabaseScope,
  syncSetting,
} from "./setting.ts";

/** The policy is a singleton named `default`. */
const SETTING_NAME = "default";

export interface ManagedInstanceLongTermRetentionPolicyProps {
  /** Resource group of the managed instance. Changing it replaces the policy. */
  resourceGroup: string;
  /** Name of the SQL managed instance. Changing it replaces the policy. */
  managedInstance: string;
  /** Name of the managed database. Changing it replaces the policy. */
  database: string;
  /** ISO 8601 retention of weekly backups, e.g. `P4W` (`PT0S` disables). */
  weeklyRetention?: string;
  /** ISO 8601 retention of monthly backups, e.g. `P12M`. */
  monthlyRetention?: string;
  /** ISO 8601 retention of yearly backups, e.g. `P5Y`. */
  yearlyRetention?: string;
  /** Week of the year (1-52) whose backup is kept as the yearly backup. */
  weekOfYear?: number;
  /** Storage tier of the backups: `Hot` or `Archive`. */
  backupStorageAccessTier?: "Hot" | "Archive";
}

export interface ManagedInstanceLongTermRetentionPolicy extends Resource<
  "Azure.Sql.ManagedInstanceLongTermRetentionPolicy",
  ManagedInstanceLongTermRetentionPolicyProps,
  {
    /** ARM resource ID of the policy. */
    policyId: string;
    /** Resource group of the managed instance. */
    resourceGroup: string;
    /** Name of the SQL managed instance. */
    managedInstanceName: string;
    /** Name of the managed database. */
    databaseName: string;
    /** Weekly retention. */
    weeklyRetention: string | undefined;
    /** Monthly retention. */
    monthlyRetention: string | undefined;
    /** Yearly retention. */
    yearlyRetention: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Long-term backup retention (LTR) of a database on an Azure SQL Managed
 * Instance — keeps weekly, monthly, and yearly full backups for up to ten
 * years.
 *
 * This is a singleton setting that always exists on a database.
 * Destroying the resource turns long-term retention off.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/managed-instance/long-term-backup-retention-configure
 *
 * ### Keeping Backups
 * **Example:** Weekly for a month, yearly for five years
 * ```typescript
 * yield* Azure.Sql.ManagedInstanceLongTermRetentionPolicy("ltr", {
 *   resourceGroup: group.resourceGroupName,
 *   managedInstance: instance.managedInstanceName,
 *   database: database.databaseName,
 *   weeklyRetention: "P4W",
 *   yearlyRetention: "P5Y",
 *   weekOfYear: 1,
 * });
 * ```
 *
 * @resource
 */
export const ManagedInstanceLongTermRetentionPolicy =
  Resource<ManagedInstanceLongTermRetentionPolicy>(
    "Azure.Sql.ManagedInstanceLongTermRetentionPolicy",
  );

type Observed = sql.GetManagedInstanceLongTermRetentionPolicyResponse;

const getSetting = (subscriptionId: string, scope: ManagedDatabaseScope) =>
  orUndefinedIfNotFound(
    sql.GetManagedInstanceLongTermRetentionPolicy({
      ...managedDatabasePath(subscriptionId, scope),
      policyName: SETTING_NAME,
    }),
  );

const toAttrs = (
  scope: ManagedDatabaseScope,
  observed: Observed,
): ManagedInstanceLongTermRetentionPolicy["Attributes"] => ({
  policyId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  managedInstanceName: scope.managedInstanceName,
  databaseName: scope.databaseName,
  weeklyRetention: observed.properties?.weeklyRetention,
  monthlyRetention: observed.properties?.monthlyRetention,
  yearlyRetention: observed.properties?.yearlyRetention,
});

export const ManagedInstanceLongTermRetentionPolicyProvider = () =>
  Provider.succeed(ManagedInstanceLongTermRetentionPolicy, {
    stables: [
      "policyId",
      "resourceGroup",
      "managedInstanceName",
      "databaseName",
    ],

    // A singleton setting of its managed database; it disappears with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.managedInstance) !== lower(output.managedInstanceName) ||
        lower(news.database) !== lower(output.databaseName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const managedInstanceName =
        output?.managedInstanceName ?? olds?.managedInstance;
      const databaseName = output?.databaseName ?? olds?.database;
      if (
        resourceGroup === undefined ||
        managedInstanceName === undefined ||
        databaseName === undefined
      ) {
        return undefined;
      }
      const scope = { resourceGroup, managedInstanceName, databaseName };
      const observed = yield* getSetting(subscriptionId, scope);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, observed);
      return output !== undefined ||
        (yield* isManagedInstanceOwnedByStack(
          subscriptionId,
          scope.resourceGroup,
          scope.managedInstanceName,
        ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const scope: ManagedDatabaseScope = {
        resourceGroup: news.resourceGroup,
        managedInstanceName: news.managedInstance,
        databaseName: news.database,
      };
      const desired = {
        weeklyRetention: news.weeklyRetention,
        monthlyRetention: news.monthlyRetention,
        yearlyRetention: news.yearlyRetention,
        weekOfYear: news.weekOfYear,
        backupStorageAccessTier: news.backupStorageAccessTier,
      };
      const fresh = yield* syncSetting({
        label: `sql managed long-term retention on ${scope.databaseName}`,
        get: getSetting(subscriptionId, scope),
        converged: (observed) => fieldsMatch(observed.properties, desired),
        put: sql.ManagedInstanceLongTermRetentionPoliciesCreateOrUpdate({
          ...managedDatabasePath(subscriptionId, scope),
          policyName: SETTING_NAME,
          properties: desired,
        }),
      });
      return toAttrs(scope, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const label = `sql managed long-term retention on ${output.databaseName}`;
      if ((yield* getSetting(subscriptionId, output)) === undefined) return;
      // The policy cannot be removed; turn long-term retention off.
      yield* ignoreNotFound(
        syncSetting({
          label,
          get: getSetting(subscriptionId, output),
          converged: (observed) =>
            lower(observed.properties?.weeklyRetention ?? "PT0S") === "pt0s" &&
            lower(observed.properties?.monthlyRetention ?? "PT0S") === "pt0s" &&
            lower(observed.properties?.yearlyRetention ?? "PT0S") === "pt0s",
          put: sql.ManagedInstanceLongTermRetentionPoliciesCreateOrUpdate({
            ...managedDatabasePath(subscriptionId, output),
            policyName: SETTING_NAME,
            properties: {
              weeklyRetention: "PT0S",
              monthlyRetention: "PT0S",
              yearlyRetention: "PT0S",
              weekOfYear: 0,
            },
          }),
        }),
      );
    }),

    nuke: { singleton: true },
  });
