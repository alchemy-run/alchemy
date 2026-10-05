import * as sql from "@distilled.cloud/azure/sql";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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
import {
  fieldsMatch,
  isServerOwnedByStack,
  lower,
  sameSecret,
} from "./common.ts";
import {
  databasePath,
  type DatabaseScope,
  sameList,
  secretsFingerprint,
  syncSetting,
} from "./setting.ts";

/** The policy is a singleton named `default`. */
const SETTING_NAME = "default";

export interface DatabaseBlobAuditingPolicyProps {
  /** Resource group of the server. Changing it replaces the policy. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the policy. */
  server: string;
  /** Name of the database. Changing it replaces the policy. */
  database: string;
  /**
   * Whether auditing is enabled. When `Enabled`, set `storageEndpoint` or
   * `isAzureMonitorTargetEnabled`.
   */
  state: "Enabled" | "Disabled";
  /**
   * Send audit events to Azure Monitor. Also create a diagnostic setting
   * with the `SQLSecurityAuditEvents` category to route them to Log
   * Analytics, Event Hubs, or Storage.
   */
  isAzureMonitorTargetEnabled?: boolean;
  /** Blob endpoint of the storage account audit logs are written to. */
  storageEndpoint?: string;
  /** Subscription of the audit storage account. */
  storageAccountSubscriptionId?: string;
  /** Whether `storageAccountAccessKey` is the account's secondary key. */
  isStorageSecondaryKeyInUse?: boolean;
  /**
   * Authenticate to the storage account with the server's managed
   * identity (grant it `Storage Blob Data Contributor`).
   */
  isManagedIdentityInUse?: boolean;
  /** Days to keep audit logs in the storage account (0 keeps them forever). */
  retentionDays?: number;
  /**
   * Action groups and actions to audit.
   * @default ["SUCCESSFUL_DATABASE_AUTHENTICATION_GROUP", "FAILED_DATABASE_AUTHENTICATION_GROUP", "BATCH_COMPLETED_GROUP"] (Azure's default)
   */
  auditActionsAndGroups?: string[];
  /** Milliseconds before audit actions are forced to be processed (minimum 1000). */
  queueDelayMs?: number;
  /**
   * Access key of the storage account. Omit it when the managed identity is used. Write-only: Alchemy stores a salted fingerprint and only
   * re-sends it when it changes.
   */
  storageAccountAccessKey?: Redacted.Redacted<string>;
}

export interface DatabaseBlobAuditingPolicy extends Resource<
  "Azure.Sql.DatabaseBlobAuditingPolicy",
  DatabaseBlobAuditingPolicyProps,
  {
    /** ARM resource ID of the policy. */
    policyId: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Name of the database. */
    databaseName: string;
    /** Whether auditing is enabled. */
    state: string;
    /** Whether audit events go to Azure Monitor. */
    isAzureMonitorTargetEnabled: boolean | undefined;
    /** Storage endpoint audit logs are written to. */
    storageEndpoint: string | undefined;
    /** Days audit logs are kept in storage. */
    retentionDays: number | undefined;
    /** Audited action groups. */
    auditActionsAndGroups: string[];
    /** Salted fingerprint of the write-only secrets Alchemy last set. */
    secretFingerprint: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
> {}

/**
 * Database-level auditing for an Azure SQL database — writes audit
 * events to Azure Monitor and/or a storage account. Applies in addition
 * to any server-level auditing policy.
 *
 * This is a singleton setting that always exists on a database.
 * Destroying the resource disables database-level auditing again.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/auditing-overview
 *
 * ### Auditing a Database
 * **Example:** Audit failed logins to Azure Monitor
 * ```typescript
 * yield* Azure.Sql.DatabaseBlobAuditingPolicy("audit", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   database: database.databaseName,
 *   state: "Enabled",
 *   isAzureMonitorTargetEnabled: true,
 *   auditActionsAndGroups: ["FAILED_DATABASE_AUTHENTICATION_GROUP"],
 * });
 * ```
 *
 * @resource
 */
export const DatabaseBlobAuditingPolicy = Resource<DatabaseBlobAuditingPolicy>(
  "Azure.Sql.DatabaseBlobAuditingPolicy",
);

type Observed = sql.GetDatabaseBlobAuditingPolicyResponse;

const getSetting = (subscriptionId: string, scope: DatabaseScope) =>
  orUndefinedIfNotFound(
    sql.GetDatabaseBlobAuditingPolicy({
      ...databasePath(subscriptionId, scope),
      blobAuditingPolicyName: SETTING_NAME,
    }),
  );

const toAttrs = (
  scope: DatabaseScope,
  observed: Observed,
  fingerprint: Redacted.Redacted<string> | undefined,
): DatabaseBlobAuditingPolicy["Attributes"] => ({
  policyId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  serverName: scope.serverName,
  databaseName: scope.databaseName,
  state: observed.properties?.state ?? "Disabled",
  isAzureMonitorTargetEnabled: observed.properties?.isAzureMonitorTargetEnabled,
  storageEndpoint: observed.properties?.storageEndpoint || undefined,
  retentionDays: observed.properties?.retentionDays,
  auditActionsAndGroups: [
    ...(observed.properties?.auditActionsAndGroups ?? []),
  ],
  secretFingerprint: fingerprint,
});

export const DatabaseBlobAuditingPolicyProvider = () =>
  Provider.succeed(DatabaseBlobAuditingPolicy, {
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
      const attrs = toAttrs(scope, observed, output?.secretFingerprint);
      return output !== undefined ||
        (yield* isServerOwnedByStack(
          subscriptionId,
          scope.resourceGroup,
          scope.serverName,
        ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const scope: DatabaseScope = {
        resourceGroup: news.resourceGroup,
        serverName: news.server,
        databaseName: news.database,
      };
      const fingerprint = yield* secretsFingerprint(
        `${scope.resourceGroup}/${scope.databaseName}/DatabaseBlobAuditingPolicy`,
        [news.storageAccountAccessKey],
      );
      const desired = {
        state: news.state,
        isAzureMonitorTargetEnabled: news.isAzureMonitorTargetEnabled,
        storageEndpoint: news.storageEndpoint,
        storageAccountSubscriptionId: news.storageAccountSubscriptionId,
        isStorageSecondaryKeyInUse: news.isStorageSecondaryKeyInUse,
        isManagedIdentityInUse: news.isManagedIdentityInUse,
        retentionDays: news.retentionDays,
        auditActionsAndGroups: news.auditActionsAndGroups,
        queueDelayMs: news.queueDelayMs,
      };
      const fresh = yield* syncSetting({
        label: `sql database auditing on ${scope.databaseName}`,
        get: getSetting(subscriptionId, scope),
        converged: (observed) =>
          fieldsMatch(observed.properties, desired, [
            "auditActionsAndGroups",
          ]) &&
          sameList(
            observed.properties?.auditActionsAndGroups,
            desired.auditActionsAndGroups,
          ),
        put: sql.DatabaseBlobAuditingPoliciesCreateOrUpdate({
          ...databasePath(subscriptionId, scope),
          blobAuditingPolicyName: SETTING_NAME,
          properties: {
            ...desired,
            storageAccountAccessKey:
              news.storageAccountAccessKey === undefined
                ? undefined
                : Redacted.value(news.storageAccountAccessKey),
          },
        }),
        force:
          [news.storageAccountAccessKey].some(
            (secret) => secret !== undefined,
          ) && !sameSecret(fingerprint, output?.secretFingerprint),
      });
      return toAttrs(scope, fresh, fingerprint);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const label = `sql database auditing on ${output.databaseName}`;
      if ((yield* getSetting(subscriptionId, output)) === undefined) return;
      // The policy cannot be removed; disable auditing.
      yield* ignoreNotFound(
        syncSetting({
          label,
          get: getSetting(subscriptionId, output),
          converged: (observed) =>
            fieldsMatch(observed.properties, { state: "Disabled" }),
          put: sql.DatabaseBlobAuditingPoliciesCreateOrUpdate({
            ...databasePath(subscriptionId, output),
            blobAuditingPolicyName: SETTING_NAME,
            properties: { state: "Disabled" },
          }),
        }),
      );
    }),

    nuke: { singleton: true },
  });
