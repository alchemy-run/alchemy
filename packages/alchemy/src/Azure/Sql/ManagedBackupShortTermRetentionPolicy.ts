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

export interface ManagedBackupShortTermRetentionPolicyProps {
  /** Resource group of the managed instance. Changing it replaces the policy. */
  resourceGroup: string;
  /** Name of the SQL managed instance. Changing it replaces the policy. */
  managedInstance: string;
  /** Name of the managed database. Changing it replaces the policy. */
  database: string;
  /** Days point-in-time-restore backups are kept (1-35). */
  retentionDays: number;
}

export interface ManagedBackupShortTermRetentionPolicy extends Resource<
  "Azure.Sql.ManagedBackupShortTermRetentionPolicy",
  ManagedBackupShortTermRetentionPolicyProps,
  {
    /** ARM resource ID of the policy. */
    policyId: string;
    /** Resource group of the managed instance. */
    resourceGroup: string;
    /** Name of the SQL managed instance. */
    managedInstanceName: string;
    /** Name of the managed database. */
    databaseName: string;
    /** Days backups are kept. */
    retentionDays: number | undefined;
  },
  never,
  Providers
> {}

/**
 * Point-in-time-restore (short-term) backup retention of a database on an
 * Azure SQL Managed Instance.
 *
 * This is a singleton setting that always exists on a database.
 * Destroying the resource resets retention to Azure's default (7 days).
 *
 * @see https://learn.microsoft.com/azure/azure-sql/managed-instance/point-in-time-restore
 *
 * ### Configuring Retention
 * **Example:** Keep backups for two weeks
 * ```typescript
 * yield* Azure.Sql.ManagedBackupShortTermRetentionPolicy("pitr", {
 *   resourceGroup: group.resourceGroupName,
 *   managedInstance: instance.managedInstanceName,
 *   database: database.databaseName,
 *   retentionDays: 14,
 * });
 * ```
 *
 * @resource
 */
export const ManagedBackupShortTermRetentionPolicy =
  Resource<ManagedBackupShortTermRetentionPolicy>(
    "Azure.Sql.ManagedBackupShortTermRetentionPolicy",
  );

type Observed = sql.GetManagedBackupShortTermRetentionPolicyResponse;

const getSetting = (subscriptionId: string, scope: ManagedDatabaseScope) =>
  orUndefinedIfNotFound(
    sql.GetManagedBackupShortTermRetentionPolicy({
      ...managedDatabasePath(subscriptionId, scope),
      policyName: SETTING_NAME,
    }),
  );

const toAttrs = (
  scope: ManagedDatabaseScope,
  observed: Observed,
): ManagedBackupShortTermRetentionPolicy["Attributes"] => ({
  policyId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  managedInstanceName: scope.managedInstanceName,
  databaseName: scope.databaseName,
  retentionDays: observed.properties?.retentionDays,
});

export const ManagedBackupShortTermRetentionPolicyProvider = () =>
  Provider.succeed(ManagedBackupShortTermRetentionPolicy, {
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
      const desired = { retentionDays: news.retentionDays };
      const fresh = yield* syncSetting({
        label: `sql managed backup short-term retention on ${scope.databaseName}`,
        get: getSetting(subscriptionId, scope),
        converged: (observed) =>
          observed.properties?.retentionDays === desired.retentionDays,
        put: sql.ManagedBackupShortTermRetentionPoliciesCreateOrUpdate({
          ...managedDatabasePath(subscriptionId, scope),
          policyName: SETTING_NAME,
          properties: desired,
        }),
      });
      return toAttrs(scope, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const label = `sql managed backup short-term retention on ${output.databaseName}`;
      if ((yield* getSetting(subscriptionId, output)) === undefined) return;
      // The policy cannot be removed; reset retention to Azure's default of 7 days.
      yield* ignoreNotFound(
        syncSetting({
          label,
          get: getSetting(subscriptionId, output),
          converged: (observed) =>
            fieldsMatch(observed.properties, { retentionDays: 7 }),
          put: sql.ManagedBackupShortTermRetentionPoliciesCreateOrUpdate({
            ...managedDatabasePath(subscriptionId, output),
            policyName: SETTING_NAME,
            properties: { retentionDays: 7 },
          }),
        }),
      );
    }),

    nuke: { singleton: true },
  });
