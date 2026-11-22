import * as cloudhealth from "@distilled.cloud/azure/cloudhealth";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  createChildName,
  healthModelOwnedByStack,
  NAMESPACE,
  sameName,
  whileBusy,
} from "./internal.ts";

export interface AuthenticationSettingProps {
  /**
   * Resource group of the health model. Changing it replaces the setting.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /** Health model that holds the setting. Changing it replaces the setting. */
  healthModel: string;
  /**
   * Setting name: 3-260 letters, digits, and hyphens, starting and ending
   * with a letter or digit. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the setting.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Display name shown in the portal.
   * @default none
   */
  displayName?: string;
  /**
   * Managed identity the health model uses to query data sources:
   * `SystemAssigned` for the model's system-assigned identity, or the ARM
   * resource ID of a user-assigned identity attached to the model.
   * @default "SystemAssigned"
   */
  managedIdentityName?: string;
}

export interface AuthenticationSetting extends Resource<
  "Azure.CloudHealth.AuthenticationSetting",
  AuthenticationSettingProps,
  {
    /** Name of the authentication setting; reference it from signal groups and discovery rules. */
    authenticationSettingName: string;
    /** ARM resource ID of the authentication setting. */
    authenticationSettingId: string;
    /** Health model that holds the setting. */
    healthModelName: string;
    /** Resource group of the health model. */
    resourceGroup: string;
    /** Display name. */
    displayName: string | undefined;
    /** Authentication kind (always `ManagedIdentity`). */
    authenticationKind: string;
    /** Managed identity used by the setting. */
    managedIdentityName: string | undefined;
    /** Provisioning state reported by Azure, e.g. `Succeeded`. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An authentication setting of an Azure Monitor health model
 * (`Microsoft.CloudHealth/healthmodels/authenticationsettings`): the managed
 * identity the model uses to read signals from Azure Monitor, Log
 * Analytics, Azure Monitor workspaces, and Azure Resource Graph. Signal
 * groups and discovery rules reference it by name.
 *
 * Authentication settings have no tags; a setting is owned by the stack
 * that owns its health model.
 *
 * :::caution
 * Changing `name`, `healthModel`, or `resourceGroup` replaces the
 * authentication setting.
 * :::
 *
 * See [Azure Monitor health models](https://learn.microsoft.com/azure/azure-monitor/health-models/overview).
 *
 * ### Creating an Authentication Setting
 * **Example:** Use the model's system-assigned identity
 * ```typescript
 * const model = yield* Azure.CloudHealth.HealthModel("shop-health", {
 *   location: "westeurope",
 *   identity: { type: "SystemAssigned" },
 * });
 * const auth = yield* Azure.CloudHealth.AuthenticationSetting("auth", {
 *   healthModel: model.healthModelName,
 *   displayName: "System identity",
 * });
 * ```
 *
 * **Example:** Use a user-assigned identity
 * ```typescript
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("health");
 * const model = yield* Azure.CloudHealth.HealthModel("shop-health", {
 *   location: "westeurope",
 *   identity: { type: "UserAssigned", userAssignedIdentities: [identity.identityId] },
 * });
 * const auth = yield* Azure.CloudHealth.AuthenticationSetting("auth", {
 *   healthModel: model.healthModelName,
 *   managedIdentityName: identity.identityId,
 * });
 * ```
 *
 * @resource
 */
export const AuthenticationSetting = GroupedResource<AuthenticationSetting>(
  "Azure.CloudHealth.AuthenticationSetting",
);

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  healthModelName: string;
  authenticationSettingName: string;
}

const getSetting = (where: Where) =>
  orUndefinedIfNotFound(cloudhealth.GetAuthenticationSettings(where));

const toAttrs = (
  where: Where,
  observed: cloudhealth.GetAuthenticationSettingsResponse,
): AuthenticationSetting["Attributes"] => ({
  authenticationSettingName: where.authenticationSettingName,
  authenticationSettingId: observed.id ?? "",
  healthModelName: where.healthModelName,
  resourceGroup: where.resourceGroupName,
  displayName: observed.properties?.displayName,
  authenticationKind: observed.properties?.authenticationKind ?? "ManagedIdentity",
  managedIdentityName: observed.properties?.managedIdentityName,
  provisioningState: observed.properties?.provisioningState,
});

export const AuthenticationSettingProvider = () =>
  Provider.succeed(AuthenticationSetting, {
    stables: [
      "authenticationSettingName",
      "authenticationSettingId",
      "healthModelName",
      "resourceGroup",
    ],

    // Settings live inside a health model; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.healthModel, output.healthModelName) ||
        (news.name !== undefined && !sameName(news.name, output.authenticationSettingName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName = output?.resourceGroup ?? olds?.resourceGroup;
      const healthModelName = output?.healthModelName ?? olds?.healthModel;
      if (resourceGroupName === undefined || healthModelName === undefined) return undefined;
      const where = {
        subscriptionId,
        resourceGroupName,
        healthModelName,
        authenticationSettingName:
          output?.authenticationSettingName ?? olds?.name ?? (yield* createChildName(id)),
      };
      const observed = yield* getSetting(where);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(where, observed);
      return (yield* healthModelOwnedByStack(where)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, NAMESPACE);
      const where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        healthModelName: news.healthModel,
        authenticationSettingName:
          news.name ?? output?.authenticationSettingName ?? (yield* createChildName(id)),
      };
      const managedIdentityName = news.managedIdentityName ?? "SystemAssigned";

      // Observe.
      const observed = yield* getSetting(where);

      // Ensure + sync: one PUT carries every property.
      const props = observed?.properties;
      if (
        observed === undefined ||
        (news.displayName !== undefined && props?.displayName !== news.displayName) ||
        !sameName(props?.managedIdentityName, managedIdentityName)
      ) {
        yield* cloudhealth
          .AuthenticationSettingsCreateOrUpdate({
            ...where,
            properties: {
              authenticationKind: "ManagedIdentity",
              displayName: news.displayName,
              managedIdentityName,
            },
          })
          .pipe(Effect.retry(whileBusy));
      }

      const fresh = yield* waitForProvisioned(
        `health model authentication setting ${where.authenticationSettingName}`,
        getSetting(where),
        (setting) => setting.properties?.provisioningState,
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(where, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        healthModelName: output.healthModelName,
        authenticationSettingName: output.authenticationSettingName,
      };
      yield* ignoreNotFound(
        cloudhealth.DeleteAuthenticationSettings(where).pipe(Effect.retry(whileBusy)),
      );
      yield* waitUntilGone(
        `health model authentication setting ${output.authenticationSettingName}`,
        getSetting(where),
      );
    }),

    nuke: { dependsOn: ["Azure.CloudHealth.HealthModel"] },
  });
