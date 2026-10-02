import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { subsetMatches } from "./Common.ts";
import { entityLifecycle, reveal } from "./Entity.ts";

export type IdentityProviderType =
  | "aad"
  | "aadB2C"
  | "facebook"
  | "google"
  | "microsoft"
  | "twitter";

export interface IdentityProviderProps {
  /** Resource group of the API Management service. Changing it replaces the identity provider. */
  resourceGroup: string;
  /** API Management service whose developer portal uses it. Changing it replaces the identity provider. */
  serviceName: string;
  /** Identity provider type; there is at most one of each per service. Changing it replaces the identity provider. */
  type: IdentityProviderType;
  /** Client (application) ID registered with the identity provider. */
  clientId: string;
  /** Client secret registered with the identity provider. */
  clientSecret: Redacted.Redacted<string>;
  /** Allowed Microsoft Entra tenants (`aad` only). */
  allowedTenants?: string[];
  /** Tenant used for sign-in instead of `common` (`aad` only). */
  signinTenant?: string;
  /** OpenID Connect discovery authority (`aad`/`aadB2C`). */
  authority?: string;
  /** Sign-up policy name (`aadB2C` only). */
  signupPolicyName?: string;
  /** Sign-in policy name (`aadB2C` only). */
  signinPolicyName?: string;
  /** Profile editing policy name (`aadB2C` only). */
  profileEditingPolicyName?: string;
  /** Password reset policy name (`aadB2C` only). */
  passwordResetPolicyName?: string;
  /** Client library used by the developer portal (`MSAL` or `MSAL-2`). */
  clientLibrary?: string;
}

export interface IdentityProvider extends Resource<
  "Azure.ApiManagement.IdentityProvider",
  IdentityProviderProps,
  {
    /** Identity provider type. */
    type: string;
    /** ARM resource ID of the identity provider. */
    identityProviderId: string;
    /** API Management service whose developer portal uses it. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Client ID registered with the identity provider. */
    clientId: string;
  },
  never,
  Providers
> {}

/**
 * A sign-in provider (Microsoft Entra ID, Azure AD B2C, ...) of the
 * developer portal of an API Management service. Not available on the
 * Consumption tier.
 *
 * @see https://learn.microsoft.com/azure/api-management/api-management-howto-aad
 *
 * ### Developer Portal Sign-in
 * **Example:** Sign in with Microsoft Entra ID
 * ```typescript
 * yield* Azure.ApiManagement.IdentityProvider("entra", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   type: "aad",
 *   clientId: appId,
 *   clientSecret: Redacted.make(appSecret),
 *   allowedTenants: ["contoso.onmicrosoft.com"],
 *   clientLibrary: "MSAL-2",
 * });
 * ```
 *
 * @resource
 */
export const IdentityProvider = Resource<IdentityProvider>(
  "Azure.ApiManagement.IdentityProvider",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  type: string;
}

const desiredOf = (news: IdentityProviderProps) => ({
  clientId: news.clientId,
  allowedTenants: news.allowedTenants,
  signinTenant: news.signinTenant,
  authority: news.authority,
  signupPolicyName: news.signupPolicyName,
  signinPolicyName: news.signinPolicyName,
  profileEditingPolicyName: news.profileEditingPolicyName,
  passwordResetPolicyName: news.passwordResetPolicyName,
  clientLibrary: news.clientLibrary,
});

export const IdentityProviderProvider = () =>
  Provider.succeed(IdentityProvider, {
    stables: ["type", "identityProviderId", "serviceName", "resourceGroup"],
    ...entityLifecycle<
      IdentityProviderProps,
      IdentityProvider["Attributes"],
      Key,
      apim.GetIdentityProviderResponse
    >({
      label: (key) => `API Management identity provider ${key.type}`,
      keyOf: (props) =>
        Effect.succeed({
          resourceGroup: props.resourceGroup,
          serviceName: props.serviceName,
          type: props.type,
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetIdentityProvider({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          identityProviderName: key.type,
        }),
      put: (subscriptionId, key, news) =>
        apim.IdentityProviderCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          identityProviderName: key.type,
          properties: {
            ...desiredOf(news),
            type: news.type,
            clientSecret: news.clientSecret,
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteIdentityProvider({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          identityProviderName: key.type,
        }),
      // GET never returns the client secret; compare it to the last deploy.
      inSync: (news, observed, olds) =>
        olds !== undefined &&
        reveal(olds.clientSecret) === reveal(news.clientSecret) &&
        subsetMatches(desiredOf(news), observed.properties),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        type: key.type,
        identityProviderId: observed.id ?? "",
        clientId: observed.properties?.clientId ?? "",
      }),
    }),
  });
