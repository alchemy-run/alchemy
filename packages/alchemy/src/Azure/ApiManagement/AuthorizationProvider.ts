import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName, isParentOwned, sameName } from "./Common.ts";

/** Grant parameters; values such as `clientSecret` may be redacted. */
export type AuthorizationProviderGrantParameters = Record<
  string,
  string | Redacted.Redacted<string>
>;

export interface AuthorizationProviderGrantTypes {
  /**
   * Parameters of the OAuth2 authorization-code grant (interactive
   * consent), e.g. `{ clientId, clientSecret, scopes }`.
   */
  authorizationCode?: AuthorizationProviderGrantParameters;
  /**
   * Parameters of the OAuth2 client-credentials grant, e.g.
   * `{ resourceUri, scopes, loginUri, tenantId }` for `aad` (the client id
   * and secret belong to each authorization, not the provider).
   */
  clientCredentials?: AuthorizationProviderGrantParameters;
}

export interface AuthorizationProviderProps {
  /** Resource group of the API Management service. Changing it replaces the provider. */
  resourceGroup: string;
  /** API Management service that holds the provider. Changing it replaces the provider. */
  serviceName: string;
  /**
   * Authorization provider identifier. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces
   * the provider.
   */
  name?: string;
  /**
   * Display name (1-300 characters).
   * @default the provider identifier
   */
  displayName?: string;
  /**
   * Identity provider, e.g. `aad`, `aadv1`, `github`, `google`,
   * `oauth2generic`, or `oauth2pkce`. Changing it replaces the provider.
   */
  identityProvider: string;
  /**
   * OAuth2 grant settings. Secrets are never returned by Azure, so changes
   * are detected against the previously deployed props.
   */
  grantTypes: AuthorizationProviderGrantTypes;
}

export interface AuthorizationProvider extends Resource<
  "Azure.ApiManagement.AuthorizationProvider",
  AuthorizationProviderProps,
  {
    /** Authorization provider identifier. */
    authorizationProviderName: string;
    /** ARM resource ID of the authorization provider. */
    authorizationProviderId: string;
    /** API Management service that holds the provider. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Display name. */
    displayName: string;
    /** Identity provider. */
    identityProvider: string;
    /** Redirect URL to register in the OAuth application. */
    redirectUrl: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An API Management credential manager provider — OAuth2 settings for an
 * identity provider from which APIM acquires and refreshes tokens on
 * behalf of APIs (`get-authorization-context` policy).
 *
 * @see https://learn.microsoft.com/azure/api-management/credentials-overview
 *
 * ### Creating a Provider
 * **Example:** Microsoft Entra ID with the client-credentials grant
 * ```typescript
 * const entra = yield* Azure.ApiManagement.AuthorizationProvider("entra", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   identityProvider: "aad",
 *   grantTypes: {
 *     clientCredentials: {
 *       resourceUri: "https://graph.microsoft.com",
 *       scopes: "https://graph.microsoft.com/.default",
 *       loginUri: "https://login.windows.net",
 *       tenantId,
 *     },
 *   },
 * });
 * ```
 *
 * **Example:** GitHub with the authorization-code grant
 * ```typescript
 * const github = yield* Azure.ApiManagement.AuthorizationProvider("github", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   identityProvider: "github",
 *   grantTypes: {
 *     authorizationCode: {
 *       clientId: githubClientId,
 *       clientSecret: Redacted.make(githubClientSecret),
 *       scopes: "repo",
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const AuthorizationProvider = Resource<AuthorizationProvider>(
  "Azure.ApiManagement.AuthorizationProvider",
);

/**
 * Read the provider through the name-filtered list. The single-entity GET
 * serves a stale copy for minutes after an update or delete, while the
 * list reflects writes immediately.
 */
const getProvider = (
  subscriptionId: string,
  resourceGroupName: string,
  serviceName: string,
  authorizationProviderId: string,
) =>
  orUndefinedIfNotFound(
    apim
      .ListAuthorizationProviderByService({
        subscriptionId,
        resourceGroupName,
        serviceName,
        _filter: `name eq '${authorizationProviderId}'`,
      })
      // The exact-name filter matches at most one entity, so the first page
      // is authoritative even though APIM may still return a nextLink.
      .pipe(
        Effect.map((page) =>
          page.value?.find((provider) =>
            sameName(provider.name, authorizationProviderId),
          ),
        ),
      ),
  );

const revealParameters = (
  parameters: AuthorizationProviderGrantParameters | undefined,
): Record<string, string> | undefined =>
  parameters === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(parameters).map(([key, value]) => [
          key,
          typeof value === "string" ? value : Redacted.value(value),
        ]),
      );

const revealGrantTypes = (grantTypes: AuthorizationProviderGrantTypes) => ({
  authorizationCode: revealParameters(grantTypes.authorizationCode),
  clientCredentials: revealParameters(grantTypes.clientCredentials),
});

const sameParameters = (
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
) => {
  const left = Object.entries(a ?? {});
  return (
    left.length === Object.keys(b ?? {}).length &&
    left.every(([key, value]) => b?.[key] === value)
  );
};

const toAttrs = (
  resourceGroup: string,
  serviceName: string,
  name: string,
  provider: apim.AuthorizationProviderContract,
): AuthorizationProvider["Attributes"] => ({
  authorizationProviderName: name,
  authorizationProviderId: provider.id ?? "",
  serviceName,
  resourceGroup,
  displayName: provider.properties?.displayName ?? name,
  identityProvider: provider.properties?.identityProvider ?? "",
  redirectUrl: provider.properties?.oauth2?.redirectUrl,
});

export const AuthorizationProviderProvider = () =>
  Provider.succeed(AuthorizationProvider, {
    stables: [
      "authorizationProviderName",
      "authorizationProviderId",
      "serviceName",
      "resourceGroup",
      "identityProvider",
    ],

    // Providers live inside a service; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.serviceName, output.serviceName) ||
        (news.name !== undefined &&
          !sameName(news.name, output.authorizationProviderName))
      ) {
        return { action: "replace" } as const;
      }
      if (
        output.identityProvider !== "" &&
        !sameName(news.identityProvider, output.identityProvider)
      ) {
        // Same identifier: the old provider must go before the new one is created.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serviceName = output?.serviceName ?? olds?.serviceName;
      if (resourceGroup === undefined || serviceName === undefined) {
        return undefined;
      }
      const name =
        output?.authorizationProviderName ??
        olds?.name ??
        (yield* createEntityName(id));
      const observed = yield* getProvider(
        subscriptionId,
        resourceGroup,
        serviceName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, serviceName, name, observed);
      return (yield* isParentOwned(subscriptionId, resourceGroup, serviceName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ApiManagement");
      const { resourceGroup, serviceName } = news;
      const name =
        news.name ??
        output?.authorizationProviderName ??
        (yield* createEntityName(id));
      const displayName = news.displayName ?? name;
      const grantTypes = revealGrantTypes(news.grantTypes);

      // Observe. Grant secrets are write-only, so the previous props are
      // the baseline for grant changes; without them (adoption) the
      // provider is always re-sent.
      const observed = yield* getProvider(
        subscriptionId,
        resourceGroup,
        serviceName,
        name,
      );
      const previous = olds ? revealGrantTypes(olds.grantTypes) : undefined;
      const inSync =
        observed !== undefined &&
        previous !== undefined &&
        observed.properties?.displayName === displayName &&
        sameName(
          observed.properties?.identityProvider,
          news.identityProvider,
        ) &&
        sameParameters(
          grantTypes.authorizationCode,
          previous.authorizationCode,
        ) &&
        sameParameters(
          grantTypes.clientCredentials,
          previous.clientCredentials,
        );

      const current =
        inSync && observed !== undefined
          ? observed
          : yield* apim.AuthorizationProviderCreateOrUpdate({
              subscriptionId,
              resourceGroupName: resourceGroup,
              serviceName,
              authorizationProviderId: name,
              properties: {
                displayName,
                identityProvider: news.identityProvider,
                oauth2: { grantTypes },
              },
            });
      return toAttrs(resourceGroup, serviceName, name, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        apim.DeleteAuthorizationProvider({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serviceName: output.serviceName,
          authorizationProviderId: output.authorizationProviderName,
        }),
      );
      yield* waitUntilGone(
        `API Management authorization provider ${output.authorizationProviderName}`,
        getProvider(
          subscriptionId,
          output.resourceGroup,
          output.serviceName,
          output.authorizationProviderName,
        ),
        { interval: "2 seconds", times: 15 },
      );
    }),
  });
