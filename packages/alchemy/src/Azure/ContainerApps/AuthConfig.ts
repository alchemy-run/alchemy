import * as app from "@distilled.cloud/azure/app";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  fingerprint,
  isContainerAppOwnedByStack,
  lower,
  matchesDesired,
} from "./common.ts";

/** The auth config of a container app is a singleton named `current`. */
const AUTH_CONFIG_NAME = "current";

export interface AuthConfigProps {
  /** Resource group of the container app. Changing it replaces the config. */
  resourceGroup: string;
  /** Name of the container app. Changing it replaces the config. */
  containerApp: string;
  /**
   * Whether built-in authentication (Easy Auth) is enabled, and its
   * runtime version.
   */
  platform?: app.AuthPlatform;
  /**
   * What happens to unauthenticated requests (`AllowAnonymous`,
   * `RedirectToLoginPage`, `Return401`, `Return403`) and which paths are
   * excluded.
   */
  globalValidation?: app.GlobalValidation;
  /**
   * Identity providers (Microsoft Entra ID, GitHub, Google, Apple,
   * custom OpenID Connect, ...). Client secrets are referenced by
   * `clientSecretSettingName`, the name of a secret on the container app.
   */
  identityProviders?: app.IdentityProviders;
  /** Login routes, token store, and redirect settings. */
  login?: app.Login;
  /** HTTPS requirement, auth route prefix, and forward proxy settings. */
  httpSettings?: app.HttpSettings;
  /** Container app secrets used to encrypt and sign auth tokens. */
  encryptionSettings?: app.EncryptionSettings;
}

export interface AuthConfig extends Resource<
  "Azure.ContainerApps.AuthConfig",
  AuthConfigProps,
  {
    /** ARM resource ID of the auth config. */
    authConfigId: string;
    /** Name of the container app. */
    containerApp: string;
    /** Resource group of the container app. */
    resourceGroup: string;
    /** Whether built-in authentication is enabled. */
    enabled: boolean;
  },
  never,
  Providers
> {}

/**
 * Built-in authentication (Easy Auth) of a container app
 * (`Microsoft.App/containerApps/authConfigs/current`): sign users in with
 * Microsoft Entra ID, GitHub, Google, and other providers without code.
 *
 * A container app has exactly one auth config. Deleting it disables
 * built-in authentication.
 *
 * @see https://learn.microsoft.com/azure/container-apps/authentication
 *
 * ### Enabling Authentication
 * **Example:** Require GitHub sign-in
 * ```typescript
 * const api = yield* Azure.ContainerApps.ContainerApp("api", {
 *   resourceGroup: group.resourceGroupName,
 *   environmentId: env.environmentId,
 *   secrets: [{ name: "github-secret", value: Redacted.make(clientSecret) }],
 *   template: { containers: [{ name: "api", image }] },
 * });
 * yield* Azure.ContainerApps.AuthConfig("auth", {
 *   resourceGroup: group.resourceGroupName,
 *   containerApp: api.containerAppName,
 *   platform: { enabled: true },
 *   globalValidation: {
 *     unauthenticatedClientAction: "RedirectToLoginPage",
 *     redirectToProvider: "github",
 *   },
 *   identityProviders: {
 *     gitHub: {
 *       registration: {
 *         clientId: "Iv1.0123456789abcdef",
 *         clientSecretSettingName: "github-secret",
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * ### APIs
 * **Example:** Reject unauthenticated requests with 401
 * ```typescript
 * yield* Azure.ContainerApps.AuthConfig("auth", {
 *   resourceGroup: group.resourceGroupName,
 *   containerApp: api.containerAppName,
 *   platform: { enabled: true },
 *   globalValidation: {
 *     unauthenticatedClientAction: "Return401",
 *     excludedPaths: ["/health"],
 *   },
 *   identityProviders: {
 *     azureActiveDirectory: {
 *       registration: {
 *         clientId: appRegistrationClientId,
 *         openIdIssuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const AuthConfig = Resource<AuthConfig>(
  "Azure.ContainerApps.AuthConfig",
);

const getAuthConfig = (
  subscriptionId: string,
  resourceGroupName: string,
  containerAppName: string,
) =>
  orUndefinedIfNotFound(
    app.GetContainerAppsAuthConfig({
      subscriptionId,
      resourceGroupName,
      containerAppName,
      authConfigName: AUTH_CONFIG_NAME,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  containerApp: string,
  observed: app.GetContainerAppsAuthConfigResponse,
): AuthConfig["Attributes"] => ({
  authConfigId: observed.id ?? "",
  containerApp,
  resourceGroup,
  enabled: observed.properties?.platform?.enabled ?? false,
});

const toProperties = (props: AuthConfigProps): app.AuthConfigProperties => ({
  platform: props.platform,
  globalValidation: props.globalValidation,
  identityProviders: props.identityProviders,
  login: props.login,
  httpSettings: props.httpSettings,
  encryptionSettings: props.encryptionSettings,
});

export const AuthConfigProvider = () =>
  Provider.succeed(AuthConfig, {
    stables: ["authConfigId", "containerApp", "resourceGroup"],

    // Auth configs live inside a container app; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        news.containerApp !== output.containerApp
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const containerApp = output?.containerApp ?? olds?.containerApp;
      if (resourceGroup === undefined || containerApp === undefined) {
        return undefined;
      }
      const observed = yield* getAuthConfig(
        subscriptionId,
        resourceGroup,
        containerApp,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, containerApp, observed);
      // Auth configs cannot be tagged; ownership follows the container app.
      return (yield* isContainerAppOwnedByStack(
        subscriptionId,
        resourceGroup,
        containerApp,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, olds }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.App");
      const { resourceGroup, containerApp } = news;
      const properties = toProperties(news);
      const get = getAuthConfig(subscriptionId, resourceGroup, containerApp);

      // Observe.
      const observed = yield* get;

      // Ensure + sync. The PUT is a synchronous full replace; skip it when
      // the observed config already satisfies the desired one and nothing
      // was removed since the previous deploy.
      if (
        observed === undefined ||
        !matchesDesired(properties, observed.properties) ||
        (olds !== undefined &&
          fingerprint(properties) !== fingerprint(toProperties(olds)))
      ) {
        yield* app.ContainerAppsAuthConfigsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          containerAppName: containerApp,
          authConfigName: AUTH_CONFIG_NAME,
          properties,
        });
      }

      const fresh = yield* waitForProvisioned(
        `auth config of ${containerApp}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, containerApp, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        app.DeleteContainerAppsAuthConfig({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          containerAppName: output.containerApp,
          authConfigName: AUTH_CONFIG_NAME,
        }),
      );
      yield* waitUntilGone(
        `auth config of ${output.containerApp}`,
        getAuthConfig(
          subscriptionId,
          output.resourceGroup,
          output.containerApp,
        ),
        { interval: "2 seconds", times: 15 },
      );
    }),
  });
