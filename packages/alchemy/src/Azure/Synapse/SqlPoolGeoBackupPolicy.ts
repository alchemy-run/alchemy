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

export interface SqlPoolGeoBackupPolicyProps extends SqlPoolChildProps {
  /**
   * Whether daily geo-backups (restorable in the paired region) are taken.
   * @default "Enabled"
   */
  state?: SynapseEnabledState;
}

export interface SqlPoolGeoBackupPolicy extends Resource<
  "Azure.Synapse.SqlPoolGeoBackupPolicy",
  SqlPoolGeoBackupPolicyProps,
  SqlPoolChildAttrs & {
    /** ARM resource ID of the setting. */
    settingId: string;
    /** Geo-backup state. */
    state: string | undefined;
    /** Backup storage type. */
    storageType: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The geo-backup policy of a dedicated SQL pool — a daily backup copied
 * to the paired region for geo-restore.
 *
 * This is a singleton setting that always exists on a pool. Destroying the
 * resource re-enables geo-backups.
 *
 * @see https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/backup-and-restore#geo-backups-and-disaster-recovery
 *
 * ### Configuring Geo-Backups
 * **Example:** Disable geo-backups for a dev pool
 * ```typescript
 * yield* Azure.Synapse.SqlPoolGeoBackupPolicy("geo", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   sqlPool: pool.sqlPoolName,
 *   state: "Disabled",
 * });
 * ```
 *
 * **Example:** Keep geo-backups on
 * ```typescript
 * yield* Azure.Synapse.SqlPoolGeoBackupPolicy("geo", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   sqlPool: pool.sqlPoolName,
 * });
 * ```
 *
 * @resource
 */
export const SqlPoolGeoBackupPolicy = Resource<SqlPoolGeoBackupPolicy>(
  "Azure.Synapse.SqlPoolGeoBackupPolicy",
);

type Observed = synapse.GetSqlPoolGeoBackupPolicyResponse;

const getSetting = (subscriptionId: string, ref: SqlPoolChildAttrs) =>
  orUndefinedIfNotFound(
    synapse.GetSqlPoolGeoBackupPolicy({
      ...sqlPoolWhere(subscriptionId, ref),
      geoBackupPolicyName: SETTING_NAME,
    }),
  );

const toAttrs = (
  ref: SqlPoolChildAttrs,
  setting: Observed,
): SqlPoolGeoBackupPolicy["Attributes"] => ({
  ...ref,
  settingId: setting.id ?? "",
  state: setting.properties?.state,
  storageType: setting.properties?.storageType,
});

const settingSync = (
  subscriptionId: string,
  ref: SqlPoolChildAttrs,
  desired: synapse.GeoBackupPolicyPropertiesInput,
) => ({
  label: `synapse geo-backup policy on sql pool ${ref.sqlPoolName}`,
  get: getSetting(subscriptionId, ref),
  matches: (setting: Observed) => fieldsMatch(setting.properties, desired),
  put: synapse.SqlPoolGeoBackupPoliciesCreateOrUpdate({
    ...sqlPoolWhere(subscriptionId, ref),
    geoBackupPolicyName: SETTING_NAME,
    properties: desired,
  }),
});

export const SqlPoolGeoBackupPolicyProvider = () =>
  Provider.succeed(SqlPoolGeoBackupPolicy, {
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
        settingSync(subscriptionId, ref, { state: news.state ?? "Enabled" }),
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
      // The setting is never removed; restore the default (`Enabled`). A
      // locally redundant (LRS) pool cannot take geo-backups at all, so
      // there is nothing to restore.
      yield* resetSetting(
        settingSync(subscriptionId, ref, { state: "Enabled" }),
      ).pipe(Effect.catchTag("SynapseGeoBackupNotAllowed", () => Effect.void));
    }),

    nuke: { singleton: true },
  });
