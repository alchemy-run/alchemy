import * as synapse from "@distilled.cloud/azure/synapse";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { ensureRegistered, orUndefinedIfNotFound } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  auditingProperties,
  type AuditingSettingFields,
  fieldsMatch,
  isWorkspaceOwnedByStack,
  resetSetting,
  sameSecret,
  secretFingerprint,
  type SqlPoolChildAttrs,
  sqlPoolChildMoved,
  type SqlPoolChildProps,
  sqlPoolChildRef,
  sqlPoolWhere,
  syncSetting,
  unwrapSecret,
} from "./common.ts";

/** The setting is a singleton named `default`. */
const SETTING_NAME = "default";

export interface SqlPoolExtendedAuditingSettingProps
  extends SqlPoolChildProps, AuditingSettingFields {
  /**
   * T-SQL `WHERE` clause filtering audited events, e.g.
   * `statement <> 'select 1'`.
   * @default not set
   */
  predicateExpression?: string;
}

export interface SqlPoolExtendedAuditingSetting extends Resource<
  "Azure.Synapse.SqlPoolExtendedAuditingSetting",
  SqlPoolExtendedAuditingSettingProps,
  SqlPoolChildAttrs & {
    /** ARM resource ID of the setting. */
    settingId: string;
    /** Whether auditing is enabled. */
    state: string | undefined;
    /** T-SQL filter of audited events. */
    predicateExpression: string | undefined;
    /** Whether Azure Monitor is an audit target. */
    isAzureMonitorTargetEnabled: boolean | undefined;
    /** Salted fingerprint of the last storage key Alchemy set. */
    keyFingerprint: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
> {}

/**
 * Extended blob auditing of a single dedicated SQL pool
 * (`Microsoft.Synapse/workspaces/sqlPools/extendedAuditingSettings`) — pool
 * auditing plus a T-SQL predicate that filters which events are audited.
 *
 * This is a singleton policy that always exists on a pool. Destroying the
 * resource disables pool-level auditing.
 *
 * :::caution
 * Changing `workspace`, `sqlPool`, or `resourceGroup` replaces the setting.
 * Pass `resourceGroup` explicitly: this resource does not default to the
 * stack's group.
 * :::
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/auditing-overview
 *
 * ### Enabling Extended Auditing
 * **Example:** Audit everything except health probes
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
 * yield* Azure.Synapse.SqlPoolExtendedAuditingSetting("audit", {
 *   resourceGroup: workspace.resourceGroup,
 *   workspace: workspace.workspaceName,
 *   sqlPool: pool.sqlPoolName,
 *   isAzureMonitorTargetEnabled: true,
 *   predicateExpression: "statement <> 'select 1'",
 * });
 * ```
 *
 * @resource
 */
export const SqlPoolExtendedAuditingSetting = Resource<SqlPoolExtendedAuditingSetting>(
  "Azure.Synapse.SqlPoolExtendedAuditingSetting",
);

type Observed = synapse.GetExtendedSqlPoolBlobAuditingPolicyResponse;

const getSetting = (subscriptionId: string, ref: SqlPoolChildAttrs) =>
  orUndefinedIfNotFound(
    synapse.GetExtendedSqlPoolBlobAuditingPolicy({
      ...sqlPoolWhere(subscriptionId, ref),
      blobAuditingPolicyName: SETTING_NAME,
    }),
  );

const toAttrs = (
  ref: SqlPoolChildAttrs,
  setting: Observed,
  keyFingerprint: Redacted.Redacted<string> | undefined,
): SqlPoolExtendedAuditingSetting["Attributes"] => ({
  ...ref,
  settingId: setting.id ?? "",
  state: setting.properties?.state,
  predicateExpression: setting.properties?.predicateExpression,
  isAzureMonitorTargetEnabled: setting.properties?.isAzureMonitorTargetEnabled,
  keyFingerprint,
});

const settingSync = (
  subscriptionId: string,
  ref: SqlPoolChildAttrs,
  desired: synapse.ExtendedSqlPoolBlobAuditingPolicyProperties,
  storageAccountAccessKey: string | undefined,
) => ({
  label: `synapse extended auditing on sql pool ${ref.sqlPoolName}`,
  get: getSetting(subscriptionId, ref),
  matches: (setting: Observed) => fieldsMatch(setting.properties, desired),
  put: synapse.ExtendedSqlPoolBlobAuditingPoliciesCreateOrUpdate({
    ...sqlPoolWhere(subscriptionId, ref),
    blobAuditingPolicyName: SETTING_NAME,
    properties: { ...desired, storageAccountAccessKey },
  }),
});

export const SqlPoolExtendedAuditingSettingProvider = () =>
  Provider.succeed(SqlPoolExtendedAuditingSetting, {
    stables: ["settingId", "workspaceName", "resourceGroup", "sqlPoolName"],

    // A per-pool singleton setting; it disappears with its pool.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (sqlPoolChildMoved(news, output)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const ref = sqlPoolChildRef(olds, output);
      if (ref === undefined) return undefined;
      const observed = yield* getSetting(subscriptionId, ref);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(ref, observed, output?.keyFingerprint);
      return output !== undefined ||
        (yield* isWorkspaceOwnedByStack(subscriptionId, ref.resourceGroup, ref.workspaceName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Synapse");
      const ref = {
        resourceGroup: news.resourceGroup,
        workspaceName: news.workspace,
        sqlPoolName: news.sqlPool,
      };
      const fingerprint = yield* secretFingerprint(
        `${ref.resourceGroup}/${ref.workspaceName}/${ref.sqlPoolName}/extended-audit`,
        news.storageAccountAccessKey,
      );
      const sync = settingSync(
        subscriptionId,
        ref,
        {
          ...auditingProperties(news),
          predicateExpression: news.predicateExpression,
        },
        unwrapSecret(news.storageAccountAccessKey),
      );
      // The key is write-only: re-send the policy when it changed.
      const observed = yield* sync.get;
      if (
        news.storageAccountAccessKey !== undefined &&
        !sameSecret(fingerprint, output?.keyFingerprint) &&
        observed !== undefined &&
        sync.matches(observed)
      ) {
        yield* sync.put;
      }
      const fresh = yield* syncSetting(sync);
      return toAttrs(ref, fresh, fingerprint);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const ref = {
        resourceGroup: output.resourceGroup,
        workspaceName: output.workspaceName,
        sqlPoolName: output.sqlPoolName,
      };
      // The policy is never removed; disable auditing.
      yield* resetSetting(settingSync(subscriptionId, ref, { state: "Disabled" }, undefined));
    }),

    nuke: { singleton: true },
  });
