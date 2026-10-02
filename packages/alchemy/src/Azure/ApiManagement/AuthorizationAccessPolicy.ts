import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName, sameName } from "./Common.ts";
import { entityLifecycle } from "./Entity.ts";

export interface AuthorizationAccessPolicyProps {
  /** Resource group of the API Management service. Changing it replaces the policy. */
  resourceGroup: string;
  /** API Management service that holds the provider. Changing it replaces the policy. */
  serviceName: string;
  /** Identifier of the {@link AuthorizationProvider}. Changing it replaces the policy. */
  authorizationProviderName: string;
  /** Identifier of the {@link Authorization} (connection). Changing it replaces the policy. */
  authorizationName: string;
  /**
   * Access policy identifier, unique within the authorization. Changing it
   * replaces the policy.
   * @default a name generated from the stack, stage, and logical ID
   */
  name?: string;
  /** Microsoft Entra tenant of the allowed identity. Changing it replaces the policy. */
  tenantId: string;
  /**
   * Object ID of the allowed identity, typically the API Management
   * service's managed identity. Changing it replaces the policy.
   */
  objectId: string;
  /** Client application IDs that may use the connection. */
  appIds?: string[];
}

export interface AuthorizationAccessPolicy extends Resource<
  "Azure.ApiManagement.AuthorizationAccessPolicy",
  AuthorizationAccessPolicyProps,
  {
    /** Access policy identifier within the authorization. */
    accessPolicyName: string;
    /** ARM resource ID of the access policy. */
    accessPolicyId: string;
    /** Identifier of the authorization provider. */
    authorizationProviderName: string;
    /** Identifier of the authorization. */
    authorizationName: string;
    /** API Management service that holds the provider. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Tenant of the allowed identity. */
    tenantId: string;
    /** Object ID of the allowed identity. */
    objectId: string;
  },
  never,
  Providers
> {}

/**
 * Grants an identity access to the tokens of an API Management
 * credential manager {@link Authorization} (connection). Without an access
 * policy, `get-authorization-context` fails for that identity.
 *
 * @see https://learn.microsoft.com/azure/api-management/credentials-overview
 *
 * ### Granting Access
 * **Example:** Let the service's managed identity use a connection
 * ```typescript
 * yield* Azure.ApiManagement.AuthorizationAccessPolicy("graph-access", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   authorizationProviderName: provider.authorizationProviderName,
 *   authorizationName: connection.authorizationName,
 *   tenantId,
 *   objectId: apim.principalId!,
 * });
 * ```
 *
 * @resource
 */
export const AuthorizationAccessPolicy = Resource<AuthorizationAccessPolicy>(
  "Azure.ApiManagement.AuthorizationAccessPolicy",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  authorizationProviderName: string;
  authorizationName: string;
  accessPolicyName: string;
}

export const AuthorizationAccessPolicyProvider = () =>
  Provider.succeed(AuthorizationAccessPolicy, {
    stables: [
      "accessPolicyName",
      "accessPolicyId",
      "authorizationProviderName",
      "authorizationName",
      "serviceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      AuthorizationAccessPolicyProps,
      AuthorizationAccessPolicy["Attributes"],
      Key,
      apim.AuthorizationAccessPolicyContract
    >({
      label: (key) =>
        `API Management access policy ${key.accessPolicyName} of authorization ${key.authorizationName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            authorizationProviderName: props.authorizationProviderName,
            authorizationName: props.authorizationName,
            accessPolicyName:
              props.name ??
              output?.accessPolicyName ??
              (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      // Credential manager GETs serve stale copies after writes; the
      // exact-name filtered list does not and returns at most one entity.
      get: (subscriptionId, key) =>
        apim
          .ListAuthorizationAccessPolicyByAuthorization({
            subscriptionId,
            resourceGroupName: key.resourceGroup,
            serviceName: key.serviceName,
            authorizationProviderId: key.authorizationProviderName,
            authorizationId: key.authorizationName,
            _filter: `name eq '${key.accessPolicyName}'`,
          })
          .pipe(
            Effect.map((page) =>
              page.value?.find((item) =>
                sameName(item.name, key.accessPolicyName),
              ),
            ),
          ),
      put: (subscriptionId, key, news) =>
        apim.AuthorizationAccessPolicyCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          authorizationProviderId: key.authorizationProviderName,
          authorizationId: key.authorizationName,
          authorizationAccessPolicyId: key.accessPolicyName,
          properties: {
            tenantId: news.tenantId,
            objectId: news.objectId,
            appIds: news.appIds,
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteAuthorizationAccessPolicy({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          authorizationProviderId: key.authorizationProviderName,
          authorizationId: key.authorizationName,
          authorizationAccessPolicyId: key.accessPolicyName,
        }),
      inSync: (news, observed) =>
        sameName(observed.properties?.tenantId, news.tenantId) &&
        sameName(observed.properties?.objectId, news.objectId) &&
        (observed.properties?.appIds ?? []).join(",") ===
          (news.appIds ?? []).join(","),
      replaceOn: (news, _olds, output) =>
        !sameName(news.tenantId, output.tenantId) ||
        !sameName(news.objectId, output.objectId),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        authorizationProviderName: key.authorizationProviderName,
        authorizationName: key.authorizationName,
        accessPolicyName: key.accessPolicyName,
        accessPolicyId: observed.id ?? "",
        tenantId: observed.properties?.tenantId ?? "",
        objectId: observed.properties?.objectId ?? "",
      }),
    }),
  });
