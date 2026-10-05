import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName, sameName } from "./Common.ts";
import { entityLifecycle, reveal, sameSecrets } from "./Entity.ts";

export interface AuthorizationProps {
  /** Resource group of the API Management service. Changing it replaces the authorization. */
  resourceGroup: string;
  /** API Management service that holds the provider. Changing it replaces the authorization. */
  serviceName: string;
  /** Identifier of the {@link AuthorizationProvider}. Changing it replaces the authorization. */
  authorizationProviderName: string;
  /**
   * Authorization (connection) identifier, unique within the provider.
   * Changing it replaces the authorization.
   * @default a name generated from the stack, stage, and logical ID
   */
  name?: string;
  /**
   * OAuth 2.0 grant used to obtain tokens. `AuthorizationCode` needs an
   * interactive consent (login link) before tokens are issued;
   * `ClientCredentials` is fully automatic. Changing it replaces the
   * authorization.
   */
  oauth2GrantType: "AuthorizationCode" | "ClientCredentials";
  /**
   * Grant parameters, e.g. `{ clientId, clientSecret }` for
   * `ClientCredentials`. Azure never returns them, so changes are detected
   * against the previously deployed values.
   */
  parameters?: Record<string, Redacted.Redacted<string>>;
}

export interface Authorization extends Resource<
  "Azure.ApiManagement.Authorization",
  AuthorizationProps,
  {
    /** Authorization identifier within the provider. */
    authorizationName: string;
    /** ARM resource ID of the authorization. */
    authorizationId: string;
    /** Identifier of the authorization provider. */
    authorizationProviderName: string;
    /** API Management service that holds the provider. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** OAuth 2.0 grant type. */
    oauth2GrantType: string;
    /** Connection status reported by APIM (`Connected`, `Error`, ...). */
    status: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A connection (authorization) of an API Management credential manager
 * {@link AuthorizationProvider}. APIM obtains and refreshes the OAuth 2.0
 * tokens; policies fetch them with `get-authorization-context`. Callers
 * need an {@link AuthorizationAccessPolicy} to use it.
 *
 * @see https://learn.microsoft.com/azure/api-management/credentials-overview
 *
 * ### Creating Connections
 * **Example:** A client-credentials connection to Microsoft Graph
 * ```typescript
 * const connection = yield* Azure.ApiManagement.Authorization("graph", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   authorizationProviderName: provider.authorizationProviderName,
 *   oauth2GrantType: "ClientCredentials",
 *   parameters: {
 *     clientId: Redacted.make(appId),
 *     clientSecret: Redacted.make(appSecret),
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Authorization = Resource<Authorization>(
  "Azure.ApiManagement.Authorization",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  authorizationProviderName: string;
  authorizationName: string;
}

/**
 * Provider layer of {@link Authorization}. (`AuthorizationProvider` is the
 * credential manager provider resource.)
 */
export const AuthorizationResourceProvider = () =>
  Provider.succeed(Authorization, {
    stables: [
      "authorizationName",
      "authorizationId",
      "authorizationProviderName",
      "serviceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      AuthorizationProps,
      Authorization["Attributes"],
      Key,
      apim.AuthorizationContract
    >({
      label: (key) =>
        `API Management authorization ${key.authorizationName} of provider ${key.authorizationProviderName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            authorizationProviderName: props.authorizationProviderName,
            authorizationName:
              props.name ??
              output?.authorizationName ??
              (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      // The single-entity GET of credential manager entities serves a stale
      // copy for minutes after writes; the name-filtered list does not.
      // The exact-name filter matches at most one entity, so the first page
      // is authoritative.
      get: (subscriptionId, key) =>
        apim
          .ListAuthorizationByAuthorizationProvider({
            subscriptionId,
            resourceGroupName: key.resourceGroup,
            serviceName: key.serviceName,
            authorizationProviderId: key.authorizationProviderName,
            _filter: `name eq '${key.authorizationName}'`,
          })
          .pipe(
            Effect.map((page) =>
              page.value?.find((item) =>
                sameName(item.name, key.authorizationName),
              ),
            ),
          ),
      put: (subscriptionId, key, news) =>
        apim.AuthorizationCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          authorizationProviderId: key.authorizationProviderName,
          authorizationId: key.authorizationName,
          properties: {
            authorizationType: "OAuth2",
            oauth2grantType: news.oauth2GrantType,
            parameters:
              news.parameters === undefined
                ? undefined
                : Object.fromEntries(
                    Object.entries(news.parameters).map(([k, v]) => [
                      k,
                      reveal(v),
                    ]),
                  ),
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteAuthorization({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          authorizationProviderId: key.authorizationProviderName,
          authorizationId: key.authorizationName,
        }),
      inSync: (news, _observed, olds) =>
        olds !== undefined && sameSecrets(news.parameters, olds.parameters),
      replaceOn: (news, _olds, output) =>
        news.oauth2GrantType !== output.oauth2GrantType,
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        authorizationProviderName: key.authorizationProviderName,
        authorizationName: key.authorizationName,
        authorizationId: observed.id ?? "",
        oauth2GrantType: observed.properties?.oauth2grantType ?? "",
        status: observed.properties?.status,
      }),
    }),
  });
