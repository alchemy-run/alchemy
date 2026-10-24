import * as network from "@distilled.cloud/azure/network";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { sameSet } from "./common.ts";
import { networkProvider, subsetDiffers } from "./generic.ts";

export interface AuthenticationPolicyProps {
  /** Resource group of the policy. Changing it replaces the policy. */
  resourceGroup: string;
  /**
   * Name of the policy: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the policy.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the policy.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * What the gateway does with a request that carries no valid identity:
   * `deny` it (JWT validation), `authenticate` it (redirect to sign-in),
   * or `allow` it through.
   * @default "deny"
   */
  onUnauthenticatedRequest?: "allow" | "authenticate" | "deny";
  /**
   * HTTPS URL of the Entra token issuer, with a trailing slash, e.g.
   * `https://login.microsoftonline.com/<tenant-id>/`.
   */
  issuer: string;
  /** Application (client) ID of the Entra app registration (a GUID). */
  clientId: string;
  /**
   * JWKS URI used to validate JWT signatures (JWT validation policies),
   * e.g. `https://login.microsoftonline.com/<tenant-id>/discovery/v2.0/keys`.
   */
  jwksUri?: string;
  /** Expected `aud` claim of the JWT (JWT validation policies). */
  audience?: string;
  /**
   * Key Vault secret URL holding the client secret (user sign-in
   * policies). Azure reads the secret with a user-assigned identity from
   * `userAssignedIdentityIds`.
   */
  clientSecretUrl?: string;
  /** OAuth scopes requested at sign-in (at most 10). */
  scopes?: string[];
  /**
   * Session cookie lifetime in seconds (1-604800, user sign-in policies).
   * @default 86400
   */
  sessionTimeoutSeconds?: number;
  /** Name of the session cookie (user sign-in policies). */
  sessionCookieName?: string;
  /** ARM IDs of user-assigned identities that can read `clientSecretUrl`. */
  userAssignedIdentityIds?: string[];
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface AuthenticationPolicy extends Resource<
  "Azure.Network.AuthenticationPolicy",
  AuthenticationPolicyProps,
  {
    /** Name of the policy. */
    authenticationPolicyName: string;
    /** ARM resource ID of the policy. */
    authenticationPolicyId: string;
    /** Resource group of the policy. */
    resourceGroup: string;
    /** Location of the policy. */
    location: string;
    /** Action taken on unauthenticated requests. */
    onUnauthenticatedRequest: string | undefined;
    /** Token issuer URL. */
    issuer: string | undefined;
    /** Application (client) ID. */
    clientId: string | undefined;
    /** IDs of the resources (gateway listeners) that use the policy. */
    associatedResourceIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure authentication policy (`Microsoft.Network/authenticationPolicies`)
 * — a reusable Microsoft Entra ID configuration that Application Gateway
 * applies to requests: either JWT validation (`jwksUri` + `audience`) or
 * user sign-in (`clientSecretUrl` + `scopes`). The two modes are mutually
 * exclusive. Policies are free.
 *
 * @see https://learn.microsoft.com/azure/application-gateway/json-web-token-overview
 *
 * ### Validating JWTs
 * **Example:** Deny requests without a valid Entra token
 * ```typescript
 * const policy = yield* Azure.Network.AuthenticationPolicy("api-auth", {
 *   onUnauthenticatedRequest: "deny",
 *   issuer: `https://login.microsoftonline.com/${tenantId}/`,
 *   clientId: "00000000-0000-0000-0000-000000000000",
 *   jwksUri: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
 *   audience: "api://my-api",
 * });
 * ```
 *
 * @resource
 */
export const AuthenticationPolicy = GroupedResource<AuthenticationPolicy>(
  "Azure.Network.AuthenticationPolicy",
);

export const AuthenticationPolicyProvider = () =>
  Provider.succeed(
    AuthenticationPolicy,
    networkProvider<AuthenticationPolicy>()({
      label: "authentication policy",
      nameAttr: "authenticationPolicyName",
      tracked: true,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetAuthenticationPolicy({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            authenticationPolicyName: path.name,
          }),
        ),
      body: (news, { location, tags }) => ({
        location,
        tags,
        identity:
          news.userAssignedIdentityIds === undefined || news.userAssignedIdentityIds.length === 0
            ? undefined
            : {
                type: "UserAssigned",
                userAssignedIdentities: Object.fromEntries(
                  news.userAssignedIdentityIds.map((identityId) => [identityId, {}]),
                ),
              },
        properties: {
          userTrustProviderType: "entra",
          onUnauthenticatedRequest: news.onUnauthenticatedRequest ?? "deny",
          authenticationProperties: {
            issuer: news.issuer,
            clientId: news.clientId,
            jwksUri: news.jwksUri,
            audience: news.audience,
            clientSecret: news.clientSecretUrl,
            scope: news.scopes,
            sessionTimeout:
              news.sessionTimeoutSeconds === undefined
                ? undefined
                : String(news.sessionTimeoutSeconds),
            sessionCookieName: news.sessionCookieName,
          },
        },
      }),
      put: (subscriptionId, path, body) =>
        network.AuthenticationPoliciesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          authenticationPolicyName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteAuthenticationPolicy({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          authenticationPolicyName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateAuthenticationPolicy({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          authenticationPolicyName: path.name,
          tags,
        }),
      listAll: (subscriptionId) => network.ListAuthenticationPolicyAll({ subscriptionId }),
      drifted: (observed, body, news) =>
        subsetDiffers(body.properties, observed.properties) ||
        !sameSet(
          news.userAssignedIdentityIds,
          Object.keys(observed.identity?.userAssignedIdentities ?? {}),
        ),
      toAttrs: (path, observed) => ({
        authenticationPolicyName: path.name,
        authenticationPolicyId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        onUnauthenticatedRequest: observed.properties?.onUnauthenticatedRequest,
        issuer: observed.properties?.authenticationProperties?.issuer,
        clientId: observed.properties?.authenticationProperties?.clientId,
        associatedResourceIds: [...(observed.properties?.associatedResources ?? [])],
        tags: userTags(observed.tags),
      }),
    }),
  );
