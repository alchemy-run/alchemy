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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { isServerOwnedByStack, lower } from "./common.ts";

/** The policy is a singleton named `default`. */
const POLICY_NAME = "default";

/** Azure's defaults, restored on delete. */
const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_DIFF_INTERVAL = 12;

export interface BackupShortTermRetentionPolicyProps {
  /** Resource group of the server. Changing it replaces the policy. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the policy. */
  server: string;
  /** Name of the database. Changing it replaces the policy. */
  database: string;
  /**
   * Days of point-in-time restore (1-35; the Basic tier allows at most 7).
   * @default 7
   */
  retentionDays?: number;
  /**
   * Hours between differential backups (12 or 24).
   * @default 12
   */
  diffBackupIntervalInHours?: 12 | 24;
}

export interface BackupShortTermRetentionPolicy extends Resource<
  "Azure.Sql.BackupShortTermRetentionPolicy",
  BackupShortTermRetentionPolicyProps,
  {
    /** ARM resource ID of the policy. */
    policyId: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Name of the database. */
    databaseName: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Days of point-in-time restore. */
    retentionDays: number | undefined;
    /** Hours between differential backups. */
    diffBackupIntervalInHours: number | undefined;
  },
  never,
  Providers
> {}

/**
 * The short-term (point-in-time restore) backup retention of an Azure SQL
 * database.
 *
 * This is a singleton setting that always exists on a database. Destroying
 * the resource restores Azure's defaults (7 days, 12-hour differential
 * backups).
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/automated-backups-overview
 *
 * ### Point-in-Time Restore Window
 * **Example:** Keep 14 days of point-in-time restore
 * ```typescript
 * yield* Azure.Sql.BackupShortTermRetentionPolicy("pitr", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   database: database.databaseName,
 *   retentionDays: 14,
 * });
 * ```
 *
 * **Example:** Daily differential backups
 * ```typescript
 * yield* Azure.Sql.BackupShortTermRetentionPolicy("pitr", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   database: database.databaseName,
 *   retentionDays: 7,
 *   diffBackupIntervalInHours: 24,
 * });
 * ```
 *
 * @resource
 */
export const BackupShortTermRetentionPolicy =
  Resource<BackupShortTermRetentionPolicy>(
    "Azure.Sql.BackupShortTermRetentionPolicy",
  );

type ObservedPolicy = sql.GetBackupShortTermRetentionPolicyResponse;

const getPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  serverName: string,
  databaseName: string,
) =>
  orUndefinedIfNotFound(
    sql.GetBackupShortTermRetentionPolicy({
      subscriptionId,
      resourceGroupName,
      serverName,
      databaseName,
      policyName: POLICY_NAME,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  serverName: string,
  databaseName: string,
  policy: ObservedPolicy,
): BackupShortTermRetentionPolicy["Attributes"] => ({
  policyId: policy.id ?? "",
  serverName,
  databaseName,
  resourceGroup,
  retentionDays: policy.properties?.retentionDays,
  diffBackupIntervalInHours: policy.properties?.diffBackupIntervalInHours,
});

const matches = (
  policy: ObservedPolicy,
  retentionDays: number,
  diffBackupIntervalInHours: number,
) =>
  policy.properties?.retentionDays === retentionDays &&
  policy.properties?.diffBackupIntervalInHours === diffBackupIntervalInHours;

export const BackupShortTermRetentionPolicyProvider = () =>
  Provider.succeed(BackupShortTermRetentionPolicy, {
    stables: ["policyId", "serverName", "databaseName", "resourceGroup"],

    // A per-database singleton setting; it disappears with its database.
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
      const observed = yield* getPolicy(
        subscriptionId,
        resourceGroup,
        serverName,
        databaseName,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, serverName, databaseName, observed);
      return output !== undefined ||
        (yield* isServerOwnedByStack(subscriptionId, resourceGroup, serverName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const { resourceGroup, server, database } = news;
      const retentionDays = news.retentionDays ?? DEFAULT_RETENTION_DAYS;
      const diffBackupIntervalInHours =
        news.diffBackupIntervalInHours ?? DEFAULT_DIFF_INTERVAL;
      const get = getPolicy(subscriptionId, resourceGroup, server, database);

      // Observe; the policy always exists, so only write a drift.
      const observed = yield* get;
      if (
        observed === undefined ||
        !matches(observed, retentionDays, diffBackupIntervalInHours)
      ) {
        yield* sql.BackupShortTermRetentionPoliciesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          serverName: server,
          databaseName: database,
          policyName: POLICY_NAME,
          properties: { retentionDays, diffBackupIntervalInHours },
        });
      }

      const fresh = yield* waitForProvisioned(
        `sql short-term retention on ${database}`,
        get,
        (policy) =>
          matches(policy, retentionDays, diffBackupIntervalInHours)
            ? "Succeeded"
            : "Updating",
        { interval: "3 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, server, database, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // The policy cannot be removed; restore Azure's defaults (a missing
      // database or server means there is nothing left to reset).
      yield* ignoreNotFound(
        sql.BackupShortTermRetentionPoliciesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serverName: output.serverName,
          databaseName: output.databaseName,
          policyName: POLICY_NAME,
          properties: {
            retentionDays: DEFAULT_RETENTION_DAYS,
            diffBackupIntervalInHours: DEFAULT_DIFF_INTERVAL,
          },
        }),
      );
      yield* waitUntilGone(
        `sql short-term retention on ${output.databaseName}`,
        getPolicy(
          subscriptionId,
          output.resourceGroup,
          output.serverName,
          output.databaseName,
        ).pipe(
          Effect.map((policy) =>
            policy === undefined ||
            matches(policy, DEFAULT_RETENTION_DAYS, DEFAULT_DIFF_INTERVAL)
              ? undefined
              : policy,
          ),
        ),
        { interval: "3 seconds", times: 60 },
      );
    }),

    nuke: { singleton: true },
  });
