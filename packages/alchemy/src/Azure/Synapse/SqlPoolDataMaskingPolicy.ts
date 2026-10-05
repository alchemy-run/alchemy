import * as synapse from "@distilled.cloud/azure/synapse";
import * as Effect from "effect/Effect";
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
  type SqlPoolChildAttrs,
  sqlPoolChildMoved,
  type SqlPoolChildProps,
  sqlPoolChildRef,
  sqlPoolWhere,
  type SynapseEnabledState,
  syncSetting,
} from "./common.ts";

/** The setting is a singleton named `Default`. */
const SETTING_NAME = "Default";

export interface SqlPoolDataMaskingPolicyProps extends SqlPoolChildProps {
  /**
   * Whether dynamic data masking is on. Azure only keeps `Enabled` while
   * the pool has at least one exempt principal (other than `dbo`) or
   * masking rule; otherwise it reports `Disabled`. Disabling masking
   * clears `exemptPrincipals`.
   * @default "Enabled"
   */
  dataMaskingState?: SynapseEnabledState;
  /**
   * Semicolon-separated database users that see unmasked data, e.g.
   * `analyst1;analyst2`. Every entry must be an existing database user.
   * Administrators (`dbo`) always see unmasked data, so Azure drops them
   * from the list.
   */
  exemptPrincipals?: string;
}

export interface SqlPoolDataMaskingPolicy extends Resource<
  "Azure.Synapse.SqlPoolDataMaskingPolicy",
  SqlPoolDataMaskingPolicyProps,
  SqlPoolChildAttrs & {
    /** ARM resource ID of the setting. */
    settingId: string;
    /** Whether dynamic data masking is on. */
    dataMaskingState: string | undefined;
    /** Users that see unmasked data. */
    exemptPrincipals: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The dynamic data masking policy of a dedicated SQL pool. Masking rules
 * (`Azure.Synapse.SqlPoolDataMaskingRule`) only take effect while the
 * policy is enabled.
 *
 * This is a singleton setting that always exists on a pool. Destroying the
 * resource turns masking off.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/dynamic-data-masking-overview
 *
 * ### Enabling Data Masking
 * **Example:** Mask for everyone except analysts
 * ```typescript
 * yield* Azure.Synapse.SqlPoolDataMaskingPolicy("masking", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   sqlPool: pool.sqlPoolName,
 *   exemptPrincipals: "analyst1;analyst2",
 * });
 * ```
 *
 * @resource
 */
export const SqlPoolDataMaskingPolicy = Resource<SqlPoolDataMaskingPolicy>(
  "Azure.Synapse.SqlPoolDataMaskingPolicy",
);

type Observed = synapse.GetDataMaskingPolicyResponse;

const getSetting = (subscriptionId: string, ref: SqlPoolChildAttrs) =>
  orUndefinedIfNotFound(
    synapse.GetDataMaskingPolicy({
      ...sqlPoolWhere(subscriptionId, ref),
      dataMaskingPolicyName: SETTING_NAME,
    }),
  );

const toAttrs = (
  ref: SqlPoolChildAttrs,
  setting: Observed,
): SqlPoolDataMaskingPolicy["Attributes"] => ({
  ...ref,
  settingId: setting.id ?? "",
  dataMaskingState: setting.properties?.dataMaskingState,
  exemptPrincipals: setting.properties?.exemptPrincipals,
});

/**
 * Canonical form of a semicolon-separated principal list. Azure reorders
 * the list, appends a trailing `;`, and drops `dbo` (administrators are
 * always exempt).
 */
const principalSet = (principals: string | undefined) =>
  (principals ?? "")
    .split(";")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p !== "" && p !== "dbo")
    .sort()
    .join(";");

const settingSync = (
  subscriptionId: string,
  ref: SqlPoolChildAttrs,
  desired: synapse.DataMaskingPolicyPropertiesInput,
) => ({
  label: `synapse data masking policy on sql pool ${ref.sqlPoolName}`,
  get: getSetting(subscriptionId, ref),
  matches: (setting: Observed) =>
    fieldsMatch(
      setting.properties?.dataMaskingState,
      desired.dataMaskingState,
    ) &&
    // Disabling masking clears the exempt list.
    (desired.dataMaskingState === "Disabled" ||
      desired.exemptPrincipals === undefined ||
      principalSet(setting.properties?.exemptPrincipals) ===
        principalSet(desired.exemptPrincipals)),
  put: synapse.DataMaskingPoliciesCreateOrUpdate({
    ...sqlPoolWhere(subscriptionId, ref),
    dataMaskingPolicyName: SETTING_NAME,
    properties: desired,
  }),
});

export const SqlPoolDataMaskingPolicyProvider = () =>
  Provider.succeed(SqlPoolDataMaskingPolicy, {
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
      const attrs = toAttrs(ref, observed);
      return output !== undefined ||
        (yield* isWorkspaceOwnedByStack(
          subscriptionId,
          ref.resourceGroup,
          ref.workspaceName,
        ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Synapse");
      const ref = {
        resourceGroup: news.resourceGroup,
        workspaceName: news.workspace,
        sqlPoolName: news.sqlPool,
      };
      const fresh = yield* syncSetting(
        settingSync(subscriptionId, ref, {
          dataMaskingState: news.dataMaskingState ?? "Enabled",
          exemptPrincipals: news.exemptPrincipals,
        }),
      );
      return toAttrs(ref, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const ref = {
        resourceGroup: output.resourceGroup,
        workspaceName: output.workspaceName,
        sqlPoolName: output.sqlPoolName,
      };
      // The setting is never removed; turn masking off.
      yield* resetSetting(
        settingSync(subscriptionId, ref, { dataMaskingState: "Disabled" }),
      );
    }),

    nuke: { singleton: true },
  });
