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
  sameList,
  secretsFingerprint,
  serverPath,
  type ServerScope,
  syncSetting,
} from "./setting.ts";

/** The policy is a singleton named `default`. */
const SETTING_NAME = "default";

export interface ExtendedServerBlobAuditingPolicyProps {
  /** Resource group of the server. Changing it replaces the policy. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the policy. */
  server: string;
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
   * T-SQL `WHERE` clause that filters audited events, e.g.
   * `statement <> 'select 1'`.
   */
  predicateExpression?: string;
  /** Audit Microsoft support (DevOps) operations to Azure Monitor. */
  isDevopsAuditEnabled?: boolean;
  /**
   * Access key of the storage account. Omit it when the managed identity is used. Write-only: Alchemy stores a salted fingerprint and only
   * re-sends it when it changes.
   */
  storageAccountAccessKey?: Redacted.Redacted<string>;
}

export interface ExtendedServerBlobAuditingPolicy extends Resource<
  "Azure.Sql.ExtendedServerBlobAuditingPolicy",
  ExtendedServerBlobAuditingPolicyProps,
  {
    /** ARM resource ID of the policy. */
    policyId: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Name of the SQL server. */
    serverName: string;
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

    /** Filter applied to audited events. */
    predicateExpression: string | undefined;
    /** Salted fingerprint of the write-only secrets Alchemy last set. */
    secretFingerprint: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
> {}

/**
 * Server-level auditing for an Azure SQL server with an event filter
 * (`predicateExpression`). Applies to every database on the server and
 * writes audit events to Azure Monitor and/or a storage account.
 *
 * This configures the same underlying policy as
 * `Azure.Sql.ServerBlobAuditingPolicy`; use one or the other per server.
 * Destroying the resource disables auditing again.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/auditing-overview
 *
 * ### Filtered Auditing
 * **Example:** Audit to Azure Monitor, skipping health probes
 * ```typescript
 * yield* Azure.Sql.ExtendedServerBlobAuditingPolicy("audit", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   state: "Enabled",
 *   isAzureMonitorTargetEnabled: true,
 *   predicateExpression: "statement <> 'select 1'",
 * });
 * ```
 *
 * @resource
 */
export const ExtendedServerBlobAuditingPolicy =
  Resource<ExtendedServerBlobAuditingPolicy>(
    "Azure.Sql.ExtendedServerBlobAuditingPolicy",
  );

type Observed = sql.GetExtendedServerBlobAuditingPolicyResponse;

const getSetting = (subscriptionId: string, scope: ServerScope) =>
  orUndefinedIfNotFound(
    sql.GetExtendedServerBlobAuditingPolicy({
      ...serverPath(subscriptionId, scope),
      blobAuditingPolicyName: SETTING_NAME,
    }),
  );

const toAttrs = (
  scope: ServerScope,
  observed: Observed,
  fingerprint: Redacted.Redacted<string> | undefined,
): ExtendedServerBlobAuditingPolicy["Attributes"] => ({
  policyId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  serverName: scope.serverName,
  state: observed.properties?.state ?? "Disabled",
  isAzureMonitorTargetEnabled: observed.properties?.isAzureMonitorTargetEnabled,
  storageEndpoint: observed.properties?.storageEndpoint || undefined,
  retentionDays: observed.properties?.retentionDays,
  auditActionsAndGroups: [
    ...(observed.properties?.auditActionsAndGroups ?? []),
  ],

  predicateExpression: observed.properties?.predicateExpression || undefined,
  secretFingerprint: fingerprint,
});

export const ExtendedServerBlobAuditingPolicyProvider = () =>
  Provider.succeed(ExtendedServerBlobAuditingPolicy, {
    stables: ["policyId", "resourceGroup", "serverName"],

    // A singleton setting of its server; it disappears with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.server) !== lower(output.serverName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serverName = output?.serverName ?? olds?.server;
      if (resourceGroup === undefined || serverName === undefined) {
        return undefined;
      }
      const scope = { resourceGroup, serverName };
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
      const scope: ServerScope = {
        resourceGroup: news.resourceGroup,
        serverName: news.server,
      };
      const fingerprint = yield* secretsFingerprint(
        `${scope.resourceGroup}/${scope.serverName}/ExtendedServerBlobAuditingPolicy`,
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

        predicateExpression: news.predicateExpression,
        isDevopsAuditEnabled: news.isDevopsAuditEnabled,
      };
      const fresh = yield* syncSetting({
        label: `sql server extended auditing on ${scope.serverName}`,
        get: getSetting(subscriptionId, scope),
        converged: (observed) =>
          fieldsMatch(observed.properties, desired, [
            "auditActionsAndGroups",
          ]) &&
          sameList(
            observed.properties?.auditActionsAndGroups,
            desired.auditActionsAndGroups,
          ),
        put: sql.ExtendedServerBlobAuditingPoliciesCreateOrUpdate({
          ...serverPath(subscriptionId, scope),
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
      const label = `sql server extended auditing on ${output.serverName}`;
      if ((yield* getSetting(subscriptionId, output)) === undefined) return;
      // The policy cannot be removed; disable auditing.
      yield* ignoreNotFound(
        syncSetting({
          label,
          get: getSetting(subscriptionId, output),
          converged: (observed) =>
            fieldsMatch(observed.properties, { state: "Disabled" }),
          put: sql.ExtendedServerBlobAuditingPoliciesCreateOrUpdate({
            ...serverPath(subscriptionId, output),
            blobAuditingPolicyName: SETTING_NAME,
            properties: { state: "Disabled" },
          }),
        }),
      );
    }),

    nuke: { singleton: true },
  });
