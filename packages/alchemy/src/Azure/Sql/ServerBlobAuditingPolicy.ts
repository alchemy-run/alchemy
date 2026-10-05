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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  fieldsMatch,
  isServerOwnedByStack,
  lower,
  sameSecret,
  secretFingerprint,
} from "./common.ts";

/** The policy is a singleton named `default`. */
const POLICY_NAME = "default";

export interface ServerBlobAuditingPolicyProps {
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
   * with the `SQLSecurityAuditEvents` category on the `master` database to
   * route them to Log Analytics, Event Hubs, or Storage.
   */
  isAzureMonitorTargetEnabled?: boolean;
  /**
   * Audit Microsoft support (DevOps) operations to Azure Monitor. Requires
   * `isAzureMonitorTargetEnabled`.
   */
  isDevopsAuditEnabled?: boolean;
  /** Blob endpoint of the storage account audit logs are written to. */
  storageEndpoint?: string;
  /**
   * Access key of the audit storage account. Write-only: Alchemy stores a
   * salted fingerprint and only re-sends the key when it changes. Omit it
   * when `isManagedIdentityInUse` is set.
   */
  storageAccountAccessKey?: Redacted.Redacted<string>;
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
   * Action groups to audit.
   * @default ["SUCCESSFUL_DATABASE_AUTHENTICATION_GROUP", "FAILED_DATABASE_AUTHENTICATION_GROUP", "BATCH_COMPLETED_GROUP"] (Azure's default)
   */
  auditActionsAndGroups?: string[];
  /**
   * Milliseconds before audit actions are forced to be processed (minimum
   * 1000).
   */
  queueDelayMs?: number;
}

export interface ServerBlobAuditingPolicy extends Resource<
  "Azure.Sql.ServerBlobAuditingPolicy",
  ServerBlobAuditingPolicyProps,
  {
    /** ARM resource ID of the policy. */
    policyId: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Resource group of the server. */
    resourceGroup: string;
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
    /** Salted fingerprint of the last storage access key Alchemy set. */
    storageKeyFingerprint: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
> {}

/**
 * Server-level auditing for an Azure SQL server. Applies to every
 * database on the server and writes audit events to Azure Monitor and/or
 * a storage account.
 *
 * This is a singleton setting that always exists on a server. Destroying
 * the resource disables auditing again.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/auditing-overview
 *
 * ### Auditing to Azure Monitor
 * **Example:** Enable auditing to Azure Monitor
 * ```typescript
 * yield* Azure.Sql.ServerBlobAuditingPolicy("audit", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   state: "Enabled",
 *   isAzureMonitorTargetEnabled: true,
 * });
 * ```
 *
 * ### Auditing to Storage
 * **Example:** Write audit logs to a storage account
 * ```typescript
 * yield* Azure.Sql.ServerBlobAuditingPolicy("audit", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   state: "Enabled",
 *   storageEndpoint: account.primaryEndpoints.blob,
 *   storageAccountAccessKey: accountKey,
 *   retentionDays: 30,
 *   auditActionsAndGroups: [
 *     "SUCCESSFUL_DATABASE_AUTHENTICATION_GROUP",
 *     "FAILED_DATABASE_AUTHENTICATION_GROUP",
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const ServerBlobAuditingPolicy = Resource<ServerBlobAuditingPolicy>(
  "Azure.Sql.ServerBlobAuditingPolicy",
);

type ObservedPolicy = sql.GetServerBlobAuditingPolicyResponse;

const getPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  serverName: string,
) =>
  orUndefinedIfNotFound(
    sql.GetServerBlobAuditingPolicy({
      subscriptionId,
      resourceGroupName,
      serverName,
      blobAuditingPolicyName: POLICY_NAME,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  serverName: string,
  policy: ObservedPolicy,
  storageKeyFingerprint: Redacted.Redacted<string> | undefined,
): ServerBlobAuditingPolicy["Attributes"] => ({
  policyId: policy.id ?? "",
  serverName,
  resourceGroup,
  state: policy.properties?.state ?? "Disabled",
  isAzureMonitorTargetEnabled: policy.properties?.isAzureMonitorTargetEnabled,
  storageEndpoint: policy.properties?.storageEndpoint || undefined,
  retentionDays: policy.properties?.retentionDays,
  auditActionsAndGroups: [...(policy.properties?.auditActionsAndGroups ?? [])],
  storageKeyFingerprint,
});

const sameGroups = (
  observed: readonly string[] | undefined,
  desired: readonly string[],
) =>
  JSON.stringify([...(observed ?? [])].map((g) => g.toUpperCase()).sort()) ===
  JSON.stringify([...desired].map((g) => g.toUpperCase()).sort());

/** Whether the observed policy reflects every desired (specified) field. */
const converged = (
  policy: ObservedPolicy,
  desired: sql.ServerBlobAuditingPolicyProperties,
) =>
  fieldsMatch(policy.properties, desired, [
    "storageAccountAccessKey",
    "auditActionsAndGroups",
  ]) &&
  (desired.auditActionsAndGroups === undefined ||
    sameGroups(
      policy.properties?.auditActionsAndGroups,
      desired.auditActionsAndGroups,
    ));

export const ServerBlobAuditingPolicyProvider = () =>
  Provider.succeed(ServerBlobAuditingPolicy, {
    stables: ["policyId", "serverName", "resourceGroup"],

    // A per-server singleton setting; it disappears with its server.
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
      const observed = yield* getPolicy(
        subscriptionId,
        resourceGroup,
        serverName,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        serverName,
        observed,
        output?.storageKeyFingerprint,
      );
      return output !== undefined ||
        (yield* isServerOwnedByStack(subscriptionId, resourceGroup, serverName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const { resourceGroup, server } = news;
      const fingerprint = yield* secretFingerprint(
        `${resourceGroup}/${server}/auditing`,
        news.storageAccountAccessKey,
      );
      const desired: sql.ServerBlobAuditingPolicyProperties = {
        state: news.state,
        isAzureMonitorTargetEnabled: news.isAzureMonitorTargetEnabled,
        isDevopsAuditEnabled: news.isDevopsAuditEnabled,
        storageEndpoint: news.storageEndpoint,
        storageAccountSubscriptionId: news.storageAccountSubscriptionId,
        isStorageSecondaryKeyInUse: news.isStorageSecondaryKeyInUse,
        isManagedIdentityInUse: news.isManagedIdentityInUse,
        retentionDays: news.retentionDays,
        auditActionsAndGroups: news.auditActionsAndGroups,
        queueDelayMs: news.queueDelayMs,
      };
      const get = getPolicy(subscriptionId, resourceGroup, server);

      // Observe; the policy always exists, so only write a drift (or a new
      // storage key, which GET never returns).
      const observed = yield* get;
      const keyChanged =
        news.storageAccountAccessKey !== undefined &&
        !sameSecret(fingerprint, output?.storageKeyFingerprint);
      if (
        observed === undefined ||
        !converged(observed, desired) ||
        keyChanged
      ) {
        yield* sql.ServerBlobAuditingPoliciesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          serverName: server,
          blobAuditingPolicyName: POLICY_NAME,
          properties: {
            ...desired,
            storageAccountAccessKey:
              news.storageAccountAccessKey === undefined
                ? undefined
                : Redacted.value(news.storageAccountAccessKey),
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `sql server auditing on ${server}`,
        get,
        (policy) => (converged(policy, desired) ? "Succeeded" : "Updating"),
        { interval: "3 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, server, fresh, fingerprint);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // The policy cannot be removed; reset it to disabled.
      yield* ignoreNotFound(
        sql.ServerBlobAuditingPoliciesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serverName: output.serverName,
          blobAuditingPolicyName: POLICY_NAME,
          properties: { state: "Disabled" },
        }),
      );
      yield* waitUntilGone(
        `sql server auditing on ${output.serverName}`,
        getPolicy(subscriptionId, output.resourceGroup, output.serverName).pipe(
          Effect.map((policy) =>
            policy?.properties?.state === "Enabled" ? policy : undefined,
          ),
        ),
        { interval: "3 seconds", times: 60 },
      );
    }),

    nuke: { singleton: true },
  });
