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
  fieldsMatch,
  isWorkspaceOwnedByStack,
  resetSetting,
  sameSecret,
  secretFingerprint,
  type SecurityAlertPolicyFields,
  securityAlertProperties,
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

export interface SqlPoolSecurityAlertPolicyProps
  extends SqlPoolChildProps, SecurityAlertPolicyFields {}

export interface SqlPoolSecurityAlertPolicy extends Resource<
  "Azure.Synapse.SqlPoolSecurityAlertPolicy",
  SqlPoolSecurityAlertPolicyProps,
  SqlPoolChildAttrs & {
    /** ARM resource ID of the setting. */
    settingId: string;
    /** Whether threat detection is on. */
    state: string | undefined;
    /** Salted fingerprint of the last storage key Alchemy set. */
    keyFingerprint: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
> {}

/**
 * The threat detection (Microsoft Defender for SQL alerts) policy of a
 * single dedicated SQL pool — alerts on SQL injection, anomalous access,
 * and data exfiltration.
 *
 * This is a singleton policy that always exists on a pool. Destroying the
 * resource disables pool-level threat detection.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/threat-detection-configure
 *
 * ### Enabling Threat Detection
 * **Example:** Alert the security team
 * ```typescript
 * yield* Azure.Synapse.SqlPoolSecurityAlertPolicy("threats", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   sqlPool: pool.sqlPoolName,
 *   emailAddresses: ["security@example.com"],
 * });
 * ```
 *
 * @resource
 */
export const SqlPoolSecurityAlertPolicy = Resource<SqlPoolSecurityAlertPolicy>(
  "Azure.Synapse.SqlPoolSecurityAlertPolicy",
);

type Observed = synapse.GetSqlPoolSecurityAlertPolicyResponse;

const getSetting = (subscriptionId: string, ref: SqlPoolChildAttrs) =>
  orUndefinedIfNotFound(
    synapse.GetSqlPoolSecurityAlertPolicy({
      ...sqlPoolWhere(subscriptionId, ref),
      securityAlertPolicyName: SETTING_NAME,
    }),
  );

const toAttrs = (
  ref: SqlPoolChildAttrs,
  setting: Observed,
  keyFingerprint: Redacted.Redacted<string> | undefined,
): SqlPoolSecurityAlertPolicy["Attributes"] => ({
  ...ref,
  settingId: setting.id ?? "",
  state: setting.properties?.state,
  keyFingerprint,
});

const settingSync = (
  subscriptionId: string,
  ref: SqlPoolChildAttrs,
  desired: synapse.SecurityAlertPolicyPropertiesInput,
  storageAccountAccessKey: string | undefined,
) => ({
  label: `synapse security alert policy on sql pool ${ref.sqlPoolName}`,
  get: getSetting(subscriptionId, ref),
  matches: (setting: Observed) => fieldsMatch(setting.properties, desired),
  put: synapse.SqlPoolSecurityAlertPoliciesCreateOrUpdate({
    ...sqlPoolWhere(subscriptionId, ref),
    securityAlertPolicyName: SETTING_NAME,
    properties: { ...desired, storageAccountAccessKey },
  }),
});

export const SqlPoolSecurityAlertPolicyProvider = () =>
  Provider.succeed(SqlPoolSecurityAlertPolicy, {
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
        `${ref.resourceGroup}/${ref.workspaceName}/${ref.sqlPoolName}/alerts`,
        news.storageAccountAccessKey,
      );
      const sync = settingSync(
        subscriptionId,
        ref,
        securityAlertProperties(news),
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
      // The policy is never removed; disable threat detection.
      yield* resetSetting(
        settingSync(subscriptionId, ref, { state: "Disabled" }, undefined),
      );
    }),

    nuke: { singleton: true },
  });
