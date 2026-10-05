import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName, subsetMatches } from "./Common.ts";
import { entityLifecycle, reveal } from "./Entity.ts";

export type AuthorizationServerGrantType =
  | "authorizationCode"
  | "implicit"
  | "resourceOwnerPassword"
  | "clientCredentials";

export interface AuthorizationServerProps {
  /** Resource group of the API Management service. Changing it replaces the server. */
  resourceGroup: string;
  /** API Management service that holds the server. Changing it replaces the server. */
  serviceName: string;
  /**
   * Authorization server identifier, unique within the service. Changing
   * it replaces the server.
   * @default a name generated from the stack, stage, and logical ID
   */
  name?: string;
  /**
   * Display name of the server; must be unique within the service.
   * @default the server identifier
   */
  displayName?: string;
  /** Description of the server (may contain HTML). */
  description?: string;
  /** Client registration page URL of the identity provider. */
  clientRegistrationEndpoint: string;
  /** OAuth 2.0 authorization endpoint. */
  authorizationEndpoint: string;
  /** OAuth 2.0 token endpoint. */
  tokenEndpoint?: string;
  /** Grant types the developer console uses to obtain tokens. */
  grantTypes: AuthorizationServerGrantType[];
  /** Client (application) ID registered with the identity provider. */
  clientId: string;
  /** Client secret registered with the identity provider. */
  clientSecret?: Redacted.Redacted<string>;
  /**
   * HTTP verbs supported by the authorization endpoint (`GET` is required).
   * @default ["GET"]
   */
  authorizationMethods?: ("GET" | "POST")[];
  /** How the token endpoint authenticates the client. */
  clientAuthenticationMethod?: ("Basic" | "Body")[];
  /**
   * How the access token is sent to the API.
   * @default ["authorizationHeader"]
   */
  bearerTokenSendingMethods?: ("authorizationHeader" | "query")[];
  /** Scope requested by default. */
  defaultScope?: string;
  /** Whether the `state` parameter is supported. */
  supportState?: boolean;
  /** Extra form parameters sent to the token endpoint. */
  tokenBodyParameters?: { name: string; value: string }[];
  /** Whether the server is offered in the developer portal test console. */
  useInTestConsole?: boolean;
  /** Whether the server is shown in the API documentation. */
  useInApiDocumentation?: boolean;
}

export interface AuthorizationServer extends Resource<
  "Azure.ApiManagement.AuthorizationServer",
  AuthorizationServerProps,
  {
    /** Authorization server identifier within the service. */
    authorizationServerName: string;
    /** ARM resource ID of the server. */
    authorizationServerId: string;
    /** API Management service that holds the server. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Display name of the server. */
    displayName: string;
  },
  never,
  Providers
> {}

/**
 * An OAuth 2.0 authorization server of an API Management service. APIs
 * reference it so the developer portal test console can obtain tokens
 * for calls.
 *
 * @see https://learn.microsoft.com/azure/api-management/api-management-howto-oauth2
 *
 * ### Configuring OAuth 2.0
 * **Example:** A Microsoft Entra authorization server
 * ```typescript
 * yield* Azure.ApiManagement.AuthorizationServer("entra", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   displayName: "Entra ID",
 *   clientRegistrationEndpoint: "https://localhost",
 *   authorizationEndpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
 *   tokenEndpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
 *   grantTypes: ["authorizationCode"],
 *   clientId: appId,
 *   clientSecret: Redacted.make(appSecret),
 *   defaultScope: `api://${appId}/.default`,
 * });
 * ```
 *
 * @resource
 */
export const AuthorizationServer = Resource<AuthorizationServer>(
  "Azure.ApiManagement.AuthorizationServer",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  authorizationServerName: string;
}

const desiredOf = (news: AuthorizationServerProps, name: string) => ({
  displayName: news.displayName ?? name,
  description: news.description,
  clientRegistrationEndpoint: news.clientRegistrationEndpoint,
  authorizationEndpoint: news.authorizationEndpoint,
  tokenEndpoint: news.tokenEndpoint,
  grantTypes: news.grantTypes,
  clientId: news.clientId,
  authorizationMethods: news.authorizationMethods ?? ["GET"],
  clientAuthenticationMethod: news.clientAuthenticationMethod,
  bearerTokenSendingMethods: news.bearerTokenSendingMethods ?? [
    "authorizationHeader",
  ],
  defaultScope: news.defaultScope,
  supportState: news.supportState,
  tokenBodyParameters: news.tokenBodyParameters,
  useInTestConsole: news.useInTestConsole,
  useInApiDocumentation: news.useInApiDocumentation,
});

export const AuthorizationServerProvider = () =>
  Provider.succeed(AuthorizationServer, {
    stables: [
      "authorizationServerName",
      "authorizationServerId",
      "serviceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      AuthorizationServerProps,
      AuthorizationServer["Attributes"],
      Key,
      apim.GetAuthorizationServerResponse
    >({
      label: (key) =>
        `API Management authorization server ${key.authorizationServerName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            authorizationServerName:
              props.name ??
              output?.authorizationServerName ??
              (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetAuthorizationServer({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          authsid: key.authorizationServerName,
        }),
      put: (subscriptionId, key, news) =>
        apim.AuthorizationServerCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          authsid: key.authorizationServerName,
          properties: {
            ...desiredOf(news, key.authorizationServerName),
            clientSecret: news.clientSecret,
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteAuthorizationServer({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          authsid: key.authorizationServerName,
        }),
      // GET never returns the client secret; compare it to the last deploy.
      inSync: (news, observed, olds) =>
        olds !== undefined &&
        reveal(olds.clientSecret) === reveal(news.clientSecret) &&
        subsetMatches(
          desiredOf(news, observed.name ?? ""),
          observed.properties,
        ),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        authorizationServerName: key.authorizationServerName,
        authorizationServerId: observed.id ?? "",
        displayName:
          observed.properties?.displayName ?? key.authorizationServerName,
      }),
    }),
  });
