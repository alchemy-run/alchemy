import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName, subsetMatches } from "./Common.ts";
import { entityLifecycle, reveal } from "./Entity.ts";

export interface OpenIdConnectProviderProps {
  /** Resource group of the API Management service. Changing it replaces the provider. */
  resourceGroup: string;
  /** API Management service that holds the provider. Changing it replaces the provider. */
  serviceName: string;
  /**
   * Provider identifier, unique within the service. Changing it replaces
   * the provider.
   * @default a name generated from the stack, stage, and logical ID
   */
  name?: string;
  /**
   * Display name of the provider.
   * @default the provider identifier
   */
  displayName?: string;
  /** Description of the provider. */
  description?: string;
  /** OpenID Connect discovery document URL (`.../.well-known/openid-configuration`). */
  metadataEndpoint: string;
  /** Client ID of the developer console application. */
  clientId: string;
  /** Client secret of the developer console application. */
  clientSecret?: Redacted.Redacted<string>;
  /** Whether the provider is offered in the developer portal test console. */
  useInTestConsole?: boolean;
  /** Whether the provider is shown in the API documentation. */
  useInApiDocumentation?: boolean;
}

export interface OpenIdConnectProvider extends Resource<
  "Azure.ApiManagement.OpenIdConnectProvider",
  OpenIdConnectProviderProps,
  {
    /** Provider identifier within the service. */
    openIdConnectProviderName: string;
    /** ARM resource ID of the provider. */
    openIdConnectProviderId: string;
    /** API Management service that holds the provider. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Display name of the provider. */
    displayName: string;
  },
  never,
  Providers
> {}

/**
 * An OpenID Connect provider of an API Management service. APIs reference
 * it so the developer portal test console can sign users in and send
 * tokens with calls.
 *
 * @see https://learn.microsoft.com/azure/api-management/api-management-howto-oauth2
 *
 * ### Configuring OpenID Connect
 * **Example:** Microsoft Entra ID as an OpenID Connect provider
 * ```typescript
 * yield* Azure.ApiManagement.OpenIdConnectProvider("entra", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   displayName: "Entra ID",
 *   metadataEndpoint: `https://login.microsoftonline.com/${tenantId}/v2.0/.well-known/openid-configuration`,
 *   clientId: appId,
 *   clientSecret: Redacted.make(appSecret),
 * });
 * ```
 *
 * @resource
 */
export const OpenIdConnectProvider = Resource<OpenIdConnectProvider>(
  "Azure.ApiManagement.OpenIdConnectProvider",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  openIdConnectProviderName: string;
}

const desiredOf = (news: OpenIdConnectProviderProps, name: string) => ({
  displayName: news.displayName ?? name,
  description: news.description,
  metadataEndpoint: news.metadataEndpoint,
  clientId: news.clientId,
  useInTestConsole: news.useInTestConsole,
  useInApiDocumentation: news.useInApiDocumentation,
});

export const OpenIdConnectProviderProvider = () =>
  Provider.succeed(OpenIdConnectProvider, {
    stables: [
      "openIdConnectProviderName",
      "openIdConnectProviderId",
      "serviceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      OpenIdConnectProviderProps,
      OpenIdConnectProvider["Attributes"],
      Key,
      apim.GetOpenIdConnectProviderResponse
    >({
      label: (key) =>
        `API Management OpenID Connect provider ${key.openIdConnectProviderName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            openIdConnectProviderName:
              props.name ??
              output?.openIdConnectProviderName ??
              (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetOpenIdConnectProvider({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          opid: key.openIdConnectProviderName,
        }),
      put: (subscriptionId, key, news) =>
        apim.OpenIdConnectProviderCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          opid: key.openIdConnectProviderName,
          properties: {
            ...desiredOf(news, key.openIdConnectProviderName),
            clientSecret: news.clientSecret,
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteOpenIdConnectProvider({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          opid: key.openIdConnectProviderName,
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
        openIdConnectProviderName: key.openIdConnectProviderName,
        openIdConnectProviderId: observed.id ?? "",
        displayName:
          observed.properties?.displayName ?? key.openIdConnectProviderName,
      }),
    }),
  });
