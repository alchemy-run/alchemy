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

/** The setting is a singleton named `current`. */
const SETTING_NAME = "current";

export interface SqlPoolTransparentDataEncryptionProps extends SqlPoolChildProps {
  /**
   * Whether transparent data encryption is enabled.
   * @default "Enabled"
   */
  status?: SynapseEnabledState;
}

export interface SqlPoolTransparentDataEncryption extends Resource<
  "Azure.Synapse.SqlPoolTransparentDataEncryption",
  SqlPoolTransparentDataEncryptionProps,
  SqlPoolChildAttrs & {
    /** ARM resource ID of the setting. */
    settingId: string;
    /** Encryption status. */
    status: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Transparent data encryption (TDE) of a dedicated SQL pool — encrypts
 * the pool's data and log files at rest with a service-managed (or
 * workspace customer-managed) key. Changing it encrypts or decrypts the
 * pool in the background.
 *
 * This is a singleton setting that always exists on a pool. Destroying the
 * resource re-enables encryption.
 *
 * @see https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/sql-data-warehouse-encryption-tde
 *
 * ### Configuring Encryption
 * **Example:** Enable TDE
 * ```typescript
 * yield* Azure.Synapse.SqlPoolTransparentDataEncryption("tde", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   sqlPool: pool.sqlPoolName,
 *   status: "Enabled",
 * });
 * ```
 *
 * **Example:** Disable TDE
 * ```typescript
 * yield* Azure.Synapse.SqlPoolTransparentDataEncryption("tde", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   sqlPool: pool.sqlPoolName,
 *   status: "Disabled",
 * });
 * ```
 *
 * @resource
 */
export const SqlPoolTransparentDataEncryption =
  Resource<SqlPoolTransparentDataEncryption>(
    "Azure.Synapse.SqlPoolTransparentDataEncryption",
  );

type Observed = synapse.GetSqlPoolTransparentDataEncryptionResponse;

const getSetting = (subscriptionId: string, ref: SqlPoolChildAttrs) =>
  orUndefinedIfNotFound(
    synapse.GetSqlPoolTransparentDataEncryption({
      ...sqlPoolWhere(subscriptionId, ref),
      transparentDataEncryptionName: SETTING_NAME,
    }),
  );

const toAttrs = (
  ref: SqlPoolChildAttrs,
  setting: Observed,
): SqlPoolTransparentDataEncryption["Attributes"] => ({
  ...ref,
  settingId: setting.id ?? "",
  status: setting.properties?.status,
});

const settingSync = (
  subscriptionId: string,
  ref: SqlPoolChildAttrs,
  desired: synapse.TransparentDataEncryptionProperties,
) => ({
  label: `synapse transparent data encryption on sql pool ${ref.sqlPoolName}`,
  get: getSetting(subscriptionId, ref),
  matches: (setting: Observed) => fieldsMatch(setting.properties, desired),
  put: synapse.SqlPoolTransparentDataEncryptionsCreateOrUpdate({
    ...sqlPoolWhere(subscriptionId, ref),
    transparentDataEncryptionName: SETTING_NAME,
    properties: desired,
  }),
});

export const SqlPoolTransparentDataEncryptionProvider = () =>
  Provider.succeed(SqlPoolTransparentDataEncryption, {
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
        settingSync(subscriptionId, ref, { status: news.status ?? "Enabled" }),
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
      // The setting is never removed; restore the secure default (`Enabled`).
      yield* resetSetting(
        settingSync(subscriptionId, ref, { status: "Enabled" }),
      );
    }),

    nuke: { singleton: true },
  });
