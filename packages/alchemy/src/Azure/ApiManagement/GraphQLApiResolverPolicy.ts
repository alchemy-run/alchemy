import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { entityLifecycle, policyInSync } from "./Entity.ts";
import type { PolicyFormat } from "./ServicePolicy.ts";

export interface GraphQLApiResolverPolicyProps {
  /** Resource group of the API Management service. Changing it replaces the policy. */
  resourceGroup: string;
  /** API Management service that holds the API. Changing it replaces the policy. */
  serviceName: string;
  /** Identifier of the GraphQL API that holds the resolver. Changing it replaces the policy. */
  apiName: string;
  /** Identifier of the resolver the policy applies to. Changing it replaces the policy. */
  resolverName: string;
  /** Resolver policy document, e.g. an `<http-data-source>` element. */
  value: string;
  /**
   * Format of `value`. `rawxml` skips XML escaping of policy expressions.
   * @default "xml"
   */
  format?: PolicyFormat;
}

export interface GraphQLApiResolverPolicy extends Resource<
  "Azure.ApiManagement.GraphQLApiResolverPolicy",
  GraphQLApiResolverPolicyProps,
  {
    /** ARM resource ID of the policy. */
    policyId: string;
    /** Identifier of the resolver the policy applies to. */
    resolverName: string;
    /** Identifier of the GraphQL API that holds the resolver. */
    apiName: string;
    /** API Management service that holds the API. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Policy document as stored by Azure (XML). */
    value: string;
  },
  never,
  Providers
> {}

/**
 * The policy of a GraphQL API resolver in API Management. It defines the
 * resolver's data source (`http-data-source`, `sql-data-source`,
 * `cosmosdb-data-source`, ...). There is one per resolver.
 *
 * @see https://learn.microsoft.com/azure/api-management/configure-graphql-resolver
 *
 * ### Defining a Data Source
 * **Example:** Resolve a field from an HTTP backend
 * ```typescript
 * yield* Azure.ApiManagement.GraphQLApiResolverPolicy("users-policy", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   apiName: graphqlApi.apiName,
 *   resolverName: resolver.resolverName,
 *   value: `<http-data-source>
 *   <http-request>
 *     <set-method>GET</set-method>
 *     <set-url>https://example.com/users</set-url>
 *   </http-request>
 * </http-data-source>`,
 * });
 * ```
 *
 * @resource
 */
export const GraphQLApiResolverPolicy = Resource<GraphQLApiResolverPolicy>(
  "Azure.ApiManagement.GraphQLApiResolverPolicy",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  apiName: string;
  resolverName: string;
}

export const GraphQLApiResolverPolicyProvider = () =>
  Provider.succeed(GraphQLApiResolverPolicy, {
    stables: [
      "policyId",
      "resolverName",
      "apiName",
      "serviceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      GraphQLApiResolverPolicyProps,
      GraphQLApiResolverPolicy["Attributes"],
      Key,
      apim.GetGraphQLApiResolverPolicyResponse
    >({
      label: (key) =>
        `API Management policy of resolver ${key.resolverName} in API ${key.apiName}`,
      keyOf: (props) =>
        Effect.succeed({
          resourceGroup: props.resourceGroup,
          serviceName: props.serviceName,
          apiName: props.apiName,
          resolverName: props.resolverName,
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetGraphQLApiResolverPolicy({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          apiId: key.apiName,
          resolverId: key.resolverName,
          policyId: "policy",
        }),
      put: (subscriptionId, key, news) =>
        apim.GraphQLApiResolverPolicyCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          apiId: key.apiName,
          resolverId: key.resolverName,
          policyId: "policy",
          properties: { value: news.value, format: news.format ?? "xml" },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteGraphQLApiResolverPolicy({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          apiId: key.apiName,
          resolverId: key.resolverName,
          policyId: "policy",
        }),
      inSync: (news, observed) => policyInSync(news, observed),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        apiName: key.apiName,
        resolverName: key.resolverName,
        policyId: observed.id ?? "",
        value: observed.properties?.value ?? "",
      }),
    }),
  });
