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
  isWorkspaceOwnedByStack,
  lower,
  resetSetting,
  syncSetting,
} from "./common.ts";

/** The setting is a singleton named `default`. */
const SETTING_NAME = "default";

/** Version Alchemy restores when the resource is destroyed. */
const DEFAULT_TLS_VERSION = "1.2";

export interface DedicatedSqlMinimalTlsSettingProps {
  /** Resource group of the workspace. Changing it replaces the setting. */
  resourceGroup: string;
  /** Name of the Synapse workspace. Changing it replaces the setting. */
  workspace: string;
  /**
   * Minimum TLS version accepted by the dedicated SQL endpoint. Azure
   * retired TLS 1.0 and 1.1 for Azure SQL endpoints: it accepts a request
   * for them but never applies it, so the deploy times out.
   * @default "1.2"
   */
  minimalTlsVersion?: string;
}

export interface DedicatedSqlMinimalTlsSetting extends Resource<
  "Azure.Synapse.DedicatedSqlMinimalTlsSetting",
  DedicatedSqlMinimalTlsSettingProps,
  {
    /** ARM resource ID of the setting. */
    settingId: string;
    /** Name of the workspace. */
    workspaceName: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Minimum TLS version of the dedicated SQL endpoint. */
    minimalTlsVersion: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The minimum TLS version accepted by a Synapse workspace's dedicated SQL
 * endpoint (`{workspace}.sql.azuresynapse.net`).
 *
 * This is a singleton setting that always exists on a workspace.
 * Destroying the resource restores TLS 1.2.
 *
 * @see https://learn.microsoft.com/azure/synapse-analytics/security/connectivity-settings#minimal-tls-version
 *
 * ### Configuring TLS
 * **Example:** Require TLS 1.2
 * ```typescript
 * yield* Azure.Synapse.DedicatedSqlMinimalTlsSetting("tls", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   minimalTlsVersion: "1.2",
 * });
 * ```
 *
 * **Example:** Pin the default
 * ```typescript
 * yield* Azure.Synapse.DedicatedSqlMinimalTlsSetting("tls", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 * });
 * ```
 *
 * @resource
 */
export const DedicatedSqlMinimalTlsSetting =
  Resource<DedicatedSqlMinimalTlsSetting>(
    "Azure.Synapse.DedicatedSqlMinimalTlsSetting",
  );

type ObservedSetting =
  synapse.GetWorkspaceManagedSqlServerDedicatedSQLMinimalTlsSettingsResponse;

const getSetting = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
) =>
  orUndefinedIfNotFound(
    synapse.GetWorkspaceManagedSqlServerDedicatedSQLMinimalTlsSettings({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      dedicatedSQLminimalTlsSettingsName: SETTING_NAME,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspaceName: string,
  setting: ObservedSetting,
): DedicatedSqlMinimalTlsSetting["Attributes"] => ({
  settingId: setting.id ?? "",
  workspaceName,
  resourceGroup,
  minimalTlsVersion: setting.properties?.minimalTlsVersion,
});

const settingSync = (
  subscriptionId: string,
  resourceGroup: string,
  workspace: string,
  minimalTlsVersion: string,
) => ({
  label: `synapse dedicated sql minimal tls on ${workspace}`,
  get: getSetting(subscriptionId, resourceGroup, workspace),
  matches: (setting: ObservedSetting) =>
    setting.properties?.minimalTlsVersion === minimalTlsVersion,
  put: synapse.UpdateWorkspaceManagedSqlServerDedicatedSQLMinimalTlsSettings({
    subscriptionId,
    resourceGroupName: resourceGroup,
    workspaceName: workspace,
    dedicatedSQLminimalTlsSettingsName: SETTING_NAME,
    properties: { minimalTlsVersion },
  }),
});

export const DedicatedSqlMinimalTlsSettingProvider = () =>
  Provider.succeed(DedicatedSqlMinimalTlsSetting, {
    stables: ["settingId", "workspaceName", "resourceGroup"],

    // A per-workspace singleton setting; it disappears with its workspace.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.workspace) !== lower(output.workspaceName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspaceName ?? olds?.workspace;
      if (resourceGroup === undefined || workspace === undefined) {
        return undefined;
      }
      const observed = yield* getSetting(
        subscriptionId,
        resourceGroup,
        workspace,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, observed);
      return output !== undefined ||
        (yield* isWorkspaceOwnedByStack(
          subscriptionId,
          resourceGroup,
          workspace,
        ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Synapse");
      const fresh = yield* syncSetting(
        settingSync(
          subscriptionId,
          news.resourceGroup,
          news.workspace,
          news.minimalTlsVersion ?? DEFAULT_TLS_VERSION,
        ),
      );
      return toAttrs(news.resourceGroup, news.workspace, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // The setting is never removed; restore the secure default.
      yield* resetSetting(
        settingSync(
          subscriptionId,
          output.resourceGroup,
          output.workspaceName,
          DEFAULT_TLS_VERSION,
        ),
      );
    }),

    nuke: { singleton: true },
  });
