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

export interface ManagedIdentitySqlControlSettingProps {
  /** Resource group of the workspace. Changing it replaces the setting. */
  resourceGroup: string;
  /** Name of the Synapse workspace. Changing it replaces the setting. */
  workspace: string;
  /**
   * Whether the workspace managed identity gets `CONTROL` permission on
   * every SQL pool (used by pipelines that run SQL as the workspace).
   * @default true
   */
  grantSqlControlToManagedIdentity?: boolean;
}

export interface ManagedIdentitySqlControlSetting extends Resource<
  "Azure.Synapse.ManagedIdentitySqlControlSetting",
  ManagedIdentitySqlControlSettingProps,
  {
    /** ARM resource ID of the setting. */
    settingId: string;
    /** Name of the workspace. */
    workspaceName: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Desired state (`Enabled` / `Disabled`). */
    desiredState: string | undefined;
    /** Actual state (`Enabled`, `Enabling`, `Disabled`, ...). */
    actualState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Whether a Synapse workspace's managed identity is granted `CONTROL` on
 * its SQL pools.
 *
 * This is a singleton setting that always exists on a workspace.
 * Destroying the resource disables the grant.
 *
 * @see https://learn.microsoft.com/azure/synapse-analytics/security/synapse-workspace-managed-identity
 *
 * ### Granting SQL Control
 * **Example:** Grant the workspace identity CONTROL on SQL pools
 * ```typescript
 * yield* Azure.Synapse.ManagedIdentitySqlControlSetting("msi-sql", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 * });
 * ```
 *
 * **Example:** Explicitly revoke the grant
 * ```typescript
 * yield* Azure.Synapse.ManagedIdentitySqlControlSetting("msi-sql", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   grantSqlControlToManagedIdentity: false,
 * });
 * ```
 *
 * @resource
 */
export const ManagedIdentitySqlControlSetting =
  Resource<ManagedIdentitySqlControlSetting>(
    "Azure.Synapse.ManagedIdentitySqlControlSetting",
  );

type ObservedSetting =
  synapse.GetWorkspaceManagedIdentitySqlControlSettingsResponse;

const getSetting = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
) =>
  orUndefinedIfNotFound(
    synapse.GetWorkspaceManagedIdentitySqlControlSettings({
      subscriptionId,
      resourceGroupName,
      workspaceName,
    }),
  );

const grantOf = (setting: ObservedSetting) =>
  setting.properties?.grantSqlControlToManagedIdentity;

const toAttrs = (
  resourceGroup: string,
  workspaceName: string,
  setting: ObservedSetting,
): ManagedIdentitySqlControlSetting["Attributes"] => ({
  settingId: setting.id ?? "",
  workspaceName,
  resourceGroup,
  desiredState: grantOf(setting)?.desiredState,
  actualState: grantOf(setting)?.actualState,
});

const settingSync = (
  subscriptionId: string,
  resourceGroup: string,
  workspace: string,
  enabled: boolean,
) => {
  const state = enabled ? "Enabled" : "Disabled";
  return {
    label: `synapse managed identity sql control on ${workspace}`,
    get: getSetting(subscriptionId, resourceGroup, workspace),
    // `actualState` passes through `Enabling`/`Disabling` before settling.
    matches: (setting: ObservedSetting) =>
      grantOf(setting)?.desiredState === state &&
      (grantOf(setting)?.actualState ?? state) === state,
    put: synapse.WorkspaceManagedIdentitySqlControlSettingsCreateOrUpdate({
      subscriptionId,
      resourceGroupName: resourceGroup,
      workspaceName: workspace,
      properties: { grantSqlControlToManagedIdentity: { desiredState: state } },
    }),
  };
};

export const ManagedIdentitySqlControlSettingProvider = () =>
  Provider.succeed(ManagedIdentitySqlControlSetting, {
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
          news.grantSqlControlToManagedIdentity ?? true,
        ),
      );
      return toAttrs(news.resourceGroup, news.workspace, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // The setting is never removed; revoke the grant.
      yield* resetSetting(
        settingSync(
          subscriptionId,
          output.resourceGroup,
          output.workspaceName,
          false,
        ),
      );
    }),

    nuke: { singleton: true },
  });
