import * as synapse from "@distilled.cloud/azure/synapse";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
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

export interface SqlPoolAuditingSettingProps
  extends SqlPoolChildProps, AuditingSettingFields {}

export interface SqlPoolAuditingSetting extends Resource<
  "Azure.Synapse.SqlPoolAuditingSetting",
  SqlPoolAuditingSettingProps,
  SqlPoolChildAttrs & {
    /** ARM resource ID of the setting. */
    settingId: string;
    /** Whether auditing is enabled. */
    state: string | undefined;
    /** Audit storage endpoint. */
    storageEndpoint: string | undefined;
    /** Whether Azure Monitor is an audit target. */
    isAzureMonitorTargetEnabled: boolean | undefined;
    /** Salted fingerprint of the last storage key Alchemy set. */
    keyFingerprint: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
> {}

/**
 * Blob auditing of a single dedicated SQL pool — writes audit logs to a
 * storage account, Log Analytics, or Event Hubs (via Azure Monitor). The
 * workspace-level policy (`Azure.Synapse.WorkspaceAuditingSetting`)
 * applies to every pool in addition to this one.
 *
 * This is a singleton policy that always exists on a pool. Destroying the
 * resource disables pool-level auditing.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/auditing-overview
 *
 * ### Enabling Auditing
 * **Example:** Audit to Azure Monitor
 * ```typescript
 * yield* Azure.Synapse.SqlPoolAuditingSetting("audit", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   sqlPool: pool.sqlPoolName,
 *   isAzureMonitorTargetEnabled: true,
 * });
 * ```
 *
 * @resource
 */
export const SqlPoolAuditingSetting = Resource<SqlPoolAuditingSetting>(
  "Azure.Synapse.SqlPoolAuditingSetting",
);

type Observed = synapse.GetSqlPoolBlobAuditingPolicyResponse;

const getSetting = (subscriptionId: string, ref: SqlPoolChildAttrs) =>
  orUndefinedIfNotFound(
    synapse.GetSqlPoolBlobAuditingPolicy({
      ...sqlPoolWhere(subscriptionId, ref),
      blobAuditingPolicyName: SETTING_NAME,
    }),
  );

const toAttrs = (
  ref: SqlPoolChildAttrs,
  setting: Observed,
  keyFingerprint: Redacted.Redacted<string> | undefined,
): SqlPoolAuditingSetting["Attributes"] => ({
  ...ref,
  settingId: setting.id ?? "",
  state: setting.properties?.state,
  storageEndpoint: setting.properties?.storageEndpoint,
  isAzureMonitorTargetEnabled: setting.properties?.isAzureMonitorTargetEnabled,
  keyFingerprint,
});

const settingSync = (
  subscriptionId: string,
  ref: SqlPoolChildAttrs,
  desired: synapse.SqlPoolBlobAuditingPolicyProperties,
  storageAccountAccessKey: string | undefined,
) => ({
  label: `synapse auditing on sql pool ${ref.sqlPoolName}`,
  get: getSetting(subscriptionId, ref),
  matches: (setting: Observed) => fieldsMatch(setting.properties, desired),
  put: synapse.SqlPoolBlobAuditingPoliciesCreateOrUpdate({
    ...sqlPoolWhere(subscriptionId, ref),
    blobAuditingPolicyName: SETTING_NAME,
    properties: { ...desired, storageAccountAccessKey },
  }),
});

export const SqlPoolAuditingSettingProvider = () =>
  Provider.succeed(SqlPoolAuditingSetting, {
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
        (yield* isWorkspaceOwnedByStack(
          subscriptionId,
          ref.resourceGroup,
          ref.workspaceName,
        ))
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
        `${ref.resourceGroup}/${ref.workspaceName}/${ref.sqlPoolName}/audit`,
        news.storageAccountAccessKey,
      );
      const { queueDelayMs: _, ...desired } = auditingProperties(news);
      const sync = settingSync(
        subscriptionId,
        ref,
        desired,
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
      yield* resetSetting(
        settingSync(subscriptionId, ref, { state: "Disabled" }, undefined),
      );
    }),

    nuke: { singleton: true },
  });
