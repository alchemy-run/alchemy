import * as web from "@distilled.cloud/azure/web";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { ensureRegistered, orUndefinedIfNotFound } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { lower, matchesDesired, siteWhere } from "./common.ts";

export interface WebAppAuthSettingsProps {
  /** Resource group of the app. Changing it replaces the settings. */
  resourceGroup: string;
  /** Name of the web app or function app. Changing it replaces them. */
  siteName: string;
  /**
   * Deployment slot of the app. Changing it replaces the settings.
   * @default the production slot
   */
  slot?: string;
  /**
   * Platform settings of the authentication module. `enabled` is always
   * set to `true` while this resource exists.
   */
  platform?: Omit<web.AuthPlatform, "enabled">;
  /**
   * Who must authenticate and what happens to unauthenticated requests,
   * e.g. `{ requireAuthentication: true, unauthenticatedClientAction: "Return401" }`.
   */
  globalValidation?: web.GlobalValidation;
  /**
   * Identity providers (Microsoft Entra ID, GitHub, Google, ...). Client
   * secrets are referenced by app setting name.
   */
  identityProviders?: web.IdentityProviders;
  /** Login flow settings (token store, routes, nonce, cookie expiration). */
  login?: web.Login;
  /** HTTP settings (HTTPS requirement, routes, forward proxy). */
  httpSettings?: web.HttpSettings;
}

export interface WebAppAuthSettings extends Resource<
  "Azure.Web.WebAppAuthSettings",
  WebAppAuthSettingsProps,
  {
    /** Name of the app. */
    siteName: string;
    /** Deployment slot, if slot-scoped. */
    slot: string | undefined;
    /** Resource group of the app. */
    resourceGroup: string;
    /** Whether App Service Authentication is enabled. */
    enabled: boolean;
    /** Whether every request must be authenticated. */
    requireAuthentication: boolean | undefined;
    /** Action taken for unauthenticated requests. */
    unauthenticatedClientAction: string | undefined;
  },
  never,
  Providers
> {}

/**
 * App Service Authentication ("Easy Auth") of a web app or function app
 * (`Microsoft.Web/sites/config/authsettingsV2`).
 *
 * The settings are a singleton of the app: creating this resource enables
 * authentication with the given configuration, and deleting it disables
 * authentication again.
 *
 * @see https://learn.microsoft.com/azure/app-service/overview-authentication-authorization
 *
 * ### Requiring Authentication
 * **Example:** Reject anonymous requests with 401
 * ```typescript
 * yield* Azure.Web.WebAppAuthSettings("auth", {
 *   resourceGroup: group.resourceGroupName,
 *   siteName: app.siteName,
 *   globalValidation: {
 *     requireAuthentication: true,
 *     unauthenticatedClientAction: "Return401",
 *   },
 * });
 * ```
 *
 * ### Identity Providers
 * **Example:** Microsoft Entra ID sign-in
 * ```typescript
 * yield* Azure.Web.WebAppAuthSettings("auth", {
 *   resourceGroup: group.resourceGroupName,
 *   siteName: app.siteName,
 *   globalValidation: {
 *     requireAuthentication: true,
 *     unauthenticatedClientAction: "RedirectToLoginPage",
 *     redirectToProvider: "azureactivedirectory",
 *   },
 *   identityProviders: {
 *     azureActiveDirectory: {
 *       enabled: true,
 *       registration: {
 *         openIdIssuer: `https://sts.windows.net/${tenantId}/v2.0`,
 *         clientId: appRegistrationClientId,
 *         clientSecretSettingName: "MICROSOFT_PROVIDER_AUTHENTICATION_SECRET",
 *       },
 *     },
 *   },
 *   login: { tokenStore: { enabled: true } },
 * });
 * ```
 *
 * @resource
 */
export const WebAppAuthSettings = Resource<WebAppAuthSettings>(
  "Azure.Web.WebAppAuthSettings",
);

const getAuthSettings = (
  subscriptionId: string,
  resourceGroup: string,
  siteName: string,
  slot: string | undefined,
) => {
  const where = siteWhere(subscriptionId, resourceGroup, siteName);
  return orUndefinedIfNotFound(
    slot === undefined
      ? web.GetWebAppAuthSettingsV2(where)
      : web.GetWebAppAuthSettingsV2Slot({ ...where, slot }),
  );
};

const putAuthSettings = (
  subscriptionId: string,
  resourceGroup: string,
  siteName: string,
  slot: string | undefined,
  properties: web.SiteAuthSettingsV2Properties,
) => {
  const where = {
    ...siteWhere(subscriptionId, resourceGroup, siteName),
    properties,
  };
  return slot === undefined
    ? web.UpdateWebAppAuthSettingsV2(where)
    : web.UpdateWebAppAuthSettingsV2Slot({ ...where, slot });
};

const toAttrs = (
  resourceGroup: string,
  siteName: string,
  slot: string | undefined,
  properties: web.SiteAuthSettingsV2Properties | undefined,
) => ({
  siteName,
  slot,
  resourceGroup,
  enabled: properties?.platform?.enabled ?? false,
  requireAuthentication: properties?.globalValidation?.requireAuthentication,
  unauthenticatedClientAction:
    properties?.globalValidation?.unauthenticatedClientAction,
});

export const WebAppAuthSettingsProvider = () =>
  Provider.succeed(WebAppAuthSettings, {
    stables: ["siteName", "slot", "resourceGroup"],

    // The settings are removed with their app.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.siteName) !== lower(output.siteName) ||
        lower(news.slot) !== lower(output.slot)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const siteName = output?.siteName ?? olds?.siteName;
      if (!resourceGroup || !siteName) return undefined;
      const slot = output?.slot ?? olds?.slot;
      const observed = yield* getAuthSettings(
        subscriptionId,
        resourceGroup,
        siteName,
        slot,
      );
      // Authentication that is disabled is the singleton's absent state.
      if (observed?.properties?.platform?.enabled !== true) return undefined;
      const attrs = toAttrs(resourceGroup, siteName, slot, observed.properties);
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const { resourceGroup, siteName, slot } = news;
      const desired: web.SiteAuthSettingsV2Properties = {
        platform: { ...news.platform, enabled: true },
        globalValidation: news.globalValidation,
        identityProviders: news.identityProviders,
        login: news.login,
        httpSettings: news.httpSettings,
      };

      // Observe.
      const observed = yield* getAuthSettings(
        subscriptionId,
        resourceGroup,
        siteName,
        slot,
      );

      // Ensure + sync: the singleton is replaced as a whole by one PUT.
      if (!matchesDesired(desired, observed?.properties)) {
        const written = yield* putAuthSettings(
          subscriptionId,
          resourceGroup,
          siteName,
          slot,
          desired,
        );
        return toAttrs(resourceGroup, siteName, slot, written.properties);
      }
      return toAttrs(resourceGroup, siteName, slot, observed?.properties);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // There is no DELETE: disabling authentication restores the default.
      const observed = yield* getAuthSettings(
        subscriptionId,
        output.resourceGroup,
        output.siteName,
        output.slot,
      );
      if (observed?.properties?.platform?.enabled !== true) return;
      yield* putAuthSettings(
        subscriptionId,
        output.resourceGroup,
        output.siteName,
        output.slot,
        { platform: { enabled: false } },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.Web.WebApp",
        "Azure.Web.FunctionApp",
        "Azure.Web.WebAppSlot",
      ],
    },
  });
