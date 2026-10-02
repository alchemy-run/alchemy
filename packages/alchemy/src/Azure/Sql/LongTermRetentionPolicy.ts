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

/** ISO 8601 zero duration: Azure's "no retention". */
const NONE = "PT0S";

export interface LongTermRetentionPolicyProps {
  /** Resource group of the server. Changing it replaces the policy. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the policy. */
  server: string;
  /** Name of the database. Changing it replaces the policy. */
  database: string;
  /**
   * How long weekly full backups are kept, as an ISO 8601 duration (e.g.
   * `P4W`, `P12W`, `P1Y`). `PT0S` keeps none.
   * @default "PT0S"
   */
  weeklyRetention?: string;
  /**
   * How long the first full backup of each month is kept (e.g. `P12M`).
   * @default "PT0S"
   */
  monthlyRetention?: string;
  /**
   * How long the yearly full backup is kept (e.g. `P5Y`).
   * @default "PT0S"
   */
  yearlyRetention?: string;
  /**
   * Week of the year (1-52) whose backup is kept as the yearly backup.
   * Required with `yearlyRetention`.
   */
  weekOfYear?: number;
  /** Make long-term backups immutable (`Enabled`) for their retention period. */
  timeBasedImmutability?: "Enabled" | "Disabled";
  /**
   * Immutability mode when `timeBasedImmutability` is enabled. `Locked`
   * backups cannot be deleted before they expire, even by an administrator.
   */
  timeBasedImmutabilityMode?: "Locked" | "Unlocked";
}

export interface LongTermRetentionPolicy extends Resource<
  "Azure.Sql.LongTermRetentionPolicy",
  LongTermRetentionPolicyProps,
  {
    /** ARM resource ID of the policy. */
    policyId: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Name of the database. */
    databaseName: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Weekly backup retention (ISO 8601). */
    weeklyRetention: string | undefined;
    /** Monthly backup retention (ISO 8601). */
    monthlyRetention: string | undefined;
    /** Yearly backup retention (ISO 8601). */
    yearlyRetention: string | undefined;
    /** Week of the year kept as the yearly backup. */
    weekOfYear: number | undefined;
  },
  never,
  Providers
> {}

/**
 * The long-term backup retention (LTR) policy of an Azure SQL database:
 * keeps weekly, monthly, and yearly full backups in RA-GRS storage for up
 * to 10 years.
 *
 * This is a singleton setting that always exists on a database. Destroying
 * the resource sets every retention back to `PT0S` (no long-term
 * backups); existing long-term backups are kept until they expire.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/long-term-retention-overview
 *
 * ### Retaining Backups
 * **Example:** Keep weekly backups for 4 weeks
 * ```typescript
 * yield* Azure.Sql.LongTermRetentionPolicy("ltr", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   database: database.databaseName,
 *   weeklyRetention: "P4W",
 * });
 * ```
 *
 * **Example:** Weekly, monthly, and yearly retention
 * ```typescript
 * yield* Azure.Sql.LongTermRetentionPolicy("ltr", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   database: database.databaseName,
 *   weeklyRetention: "P12W",
 *   monthlyRetention: "P12M",
 *   yearlyRetention: "P5Y",
 *   weekOfYear: 1,
 * });
 * ```
 *
 * @resource
 */
export const LongTermRetentionPolicy = Resource<LongTermRetentionPolicy>(
  "Azure.Sql.LongTermRetentionPolicy",
);

type ObservedPolicy = sql.GetLongTermRetentionPolicyResponse;

const getPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  serverName: string,
  databaseName: string,
) =>
  orUndefinedIfNotFound(
    sql.GetLongTermRetentionPolicy({
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
): LongTermRetentionPolicy["Attributes"] => ({
  policyId: policy.id ?? "",
  serverName,
  databaseName,
  resourceGroup,
  weeklyRetention: policy.properties?.weeklyRetention,
  monthlyRetention: policy.properties?.monthlyRetention,
  yearlyRetention: policy.properties?.yearlyRetention,
  weekOfYear: policy.properties?.weekOfYear,
});

/** Durations compare case-insensitively; a missing value means none. */
const sameDuration = (a: string | undefined, b: string | undefined) =>
  lower(a ?? NONE) === lower(b ?? NONE);

const matches = (
  policy: ObservedPolicy,
  desired: sql.LongTermRetentionPolicyProperties,
) => {
  const observed = policy.properties ?? {};
  return (
    sameDuration(observed.weeklyRetention, desired.weeklyRetention) &&
    sameDuration(observed.monthlyRetention, desired.monthlyRetention) &&
    sameDuration(observed.yearlyRetention, desired.yearlyRetention) &&
    (desired.weekOfYear === undefined ||
      observed.weekOfYear === desired.weekOfYear) &&
    (desired.timeBasedImmutability === undefined ||
      lower(observed.timeBasedImmutability) ===
        lower(desired.timeBasedImmutability)) &&
    (desired.timeBasedImmutabilityMode === undefined ||
      lower(observed.timeBasedImmutabilityMode) ===
        lower(desired.timeBasedImmutabilityMode))
  );
};

const RESET: sql.LongTermRetentionPolicyProperties = {
  weeklyRetention: NONE,
  monthlyRetention: NONE,
  yearlyRetention: NONE,
};

export const LongTermRetentionPolicyProvider = () =>
  Provider.succeed(LongTermRetentionPolicy, {
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
      const desired: sql.LongTermRetentionPolicyProperties = {
        weeklyRetention: news.weeklyRetention ?? NONE,
        monthlyRetention: news.monthlyRetention ?? NONE,
        yearlyRetention: news.yearlyRetention ?? NONE,
        weekOfYear: news.weekOfYear,
        timeBasedImmutability: news.timeBasedImmutability,
        timeBasedImmutabilityMode: news.timeBasedImmutabilityMode,
      };
      const get = getPolicy(subscriptionId, resourceGroup, server, database);

      // Observe; the policy always exists, so only write a drift.
      const observed = yield* get;
      if (observed === undefined || !matches(observed, desired)) {
        yield* sql.LongTermRetentionPoliciesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          serverName: server,
          databaseName: database,
          policyName: POLICY_NAME,
          properties: desired,
        });
      }

      const fresh = yield* waitForProvisioned(
        `sql long-term retention on ${database}`,
        get,
        (policy) => (matches(policy, desired) ? "Succeeded" : "Updating"),
        { interval: "3 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, server, database, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // The policy cannot be removed; stop taking long-term backups (a
      // missing database or server means there is nothing left to reset).
      yield* ignoreNotFound(
        sql.LongTermRetentionPoliciesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serverName: output.serverName,
          databaseName: output.databaseName,
          policyName: POLICY_NAME,
          properties: RESET,
        }),
      );
      yield* waitUntilGone(
        `sql long-term retention on ${output.databaseName}`,
        getPolicy(
          subscriptionId,
          output.resourceGroup,
          output.serverName,
          output.databaseName,
        ).pipe(
          Effect.map((policy) =>
            policy === undefined || matches(policy, RESET) ? undefined : policy,
          ),
        ),
        { interval: "3 seconds", times: 60 },
      );
    }),

    nuke: { singleton: true },
  });
