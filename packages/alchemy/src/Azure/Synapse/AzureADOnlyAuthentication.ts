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

export interface AzureADOnlyAuthenticationProps {
  /** Resource group of the workspace. Changing it replaces the setting. */
  resourceGroup: string;
  /** Name of the Synapse workspace. Changing it replaces the setting. */
  workspace: string;
  /**
   * Whether the workspace SQL endpoints only accept Microsoft Entra
   * authentication (SQL logins are rejected).
   * @default true
   */
  azureADOnlyAuthentication?: boolean;
}

export interface AzureADOnlyAuthentication extends Resource<
  "Azure.Synapse.AzureADOnlyAuthentication",
  AzureADOnlyAuthenticationProps,
  {
    /** ARM resource ID of the setting. */
    settingId: string;
    /** Name of the workspace. */
    workspaceName: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Whether only Microsoft Entra authentication is accepted. */
    azureADOnlyAuthentication: boolean;
  },
  never,
  Providers
> {}

/**
 * Microsoft Entra-only authentication for a Synapse workspace's SQL
 * endpoints. When enabled, SQL authentication (the workspace SQL
 * administrator and SQL users) is disabled.
 *
 * This is a singleton setting that always exists on a workspace.
 * Destroying the resource turns Entra-only authentication off again.
 *
 * @see https://learn.microsoft.com/azure/synapse-analytics/sql/active-directory-authentication
 *
 * ### Enforcing Entra Authentication
 * **Example:** Disable SQL authentication
 * ```typescript
 * yield* Azure.Synapse.AzureADOnlyAuthentication("entra-only", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 * });
 * ```
 *
 * **Example:** Explicitly allow SQL authentication
 * ```typescript
 * yield* Azure.Synapse.AzureADOnlyAuthentication("entra-only", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   azureADOnlyAuthentication: false,
 * });
 * ```
 *
 * @resource
 */
export const AzureADOnlyAuthentication = Resource<AzureADOnlyAuthentication>(
  "Azure.Synapse.AzureADOnlyAuthentication",
);

type ObservedSetting = synapse.GetAzureADOnlyAuthenticationResponse;

const getSetting = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
) =>
  orUndefinedIfNotFound(
    synapse.GetAzureADOnlyAuthentication({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      azureADOnlyAuthenticationName: SETTING_NAME,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspaceName: string,
  setting: ObservedSetting,
): AzureADOnlyAuthentication["Attributes"] => ({
  settingId: setting.id ?? "",
  workspaceName,
  resourceGroup,
  azureADOnlyAuthentication:
    setting.properties?.azureADOnlyAuthentication ?? false,
});

const settingSync = (
  subscriptionId: string,
  resourceGroup: string,
  workspace: string,
  desired: boolean,
) => ({
  label: `synapse entra-only authentication on ${workspace}`,
  get: getSetting(subscriptionId, resourceGroup, workspace),
  matches: (setting: ObservedSetting) =>
    (setting.properties?.azureADOnlyAuthentication ?? false) === desired,
  put: synapse.CreateAzureADOnlyAuthentication({
    subscriptionId,
    resourceGroupName: resourceGroup,
    workspaceName: workspace,
    azureADOnlyAuthenticationName: SETTING_NAME,
    properties: { azureADOnlyAuthentication: desired },
  }),
});

export const AzureADOnlyAuthenticationProvider = () =>
  Provider.succeed(AzureADOnlyAuthentication, {
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
          news.azureADOnlyAuthentication ?? true,
        ),
      );
      return toAttrs(news.resourceGroup, news.workspace, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // The setting is never removed; reset it to `false`.
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
