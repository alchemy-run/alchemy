import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName } from "./Common.ts";
import { entityLifecycle } from "./Entity.ts";

export interface GraphQLApiResolverProps {
  /** Resource group of the API Management service. Changing it replaces the resolver. */
  resourceGroup: string;
  /** API Management service that holds the API. Changing it replaces the resolver. */
  serviceName: string;
  /** Identifier of the GraphQL API (type `graphql`). Changing it replaces the resolver. */
  apiName: string;
  /**
   * Resolver identifier, unique within the API. Changing it replaces the
   * resolver.
   * @default a name generated from the stack, stage, and logical ID
   */
  name?: string;
  /** Field the resolver handles, as `Type/field`, e.g. `Query/users`. */
  path: string;
  /**
   * Display name of the resolver.
   * @default the resolver identifier
   */
  displayName?: string;
  /**
   * Description of the resolver (required by Azure).
   * @default the resolver path
   */
  description?: string;
}

export interface GraphQLApiResolver extends Resource<
  "Azure.ApiManagement.GraphQLApiResolver",
  GraphQLApiResolverProps,
  {
    /** Resolver identifier within the API. */
    resolverName: string;
    /** ARM resource ID of the resolver. */
    resolverId: string;
    /** Identifier of the GraphQL API. */
    apiName: string;
    /** API Management service that holds the API. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Field the resolver handles (`Type/field`). */
    path: string;
  },
  never,
  Providers
> {}

/**
 * A resolver of a synthetic GraphQL API in API Management. It binds one
 * schema field (`Type/field`) to a data source; the data source itself is
 * defined by the resolver's {@link GraphQLApiResolverPolicy}
 * (`http-data-source`, `sql-data-source`, ...).
 *
 * @see https://learn.microsoft.com/azure/api-management/configure-graphql-resolver
 *
 * ### Resolving GraphQL Fields
 * **Example:** Resolve `Query.users` over HTTP
 * ```typescript
 * const resolver = yield* Azure.ApiManagement.GraphQLApiResolver("users", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   apiName: graphqlApi.apiName,
 *   path: "Query/users",
 * });
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
export const GraphQLApiResolver = Resource<GraphQLApiResolver>(
  "Azure.ApiManagement.GraphQLApiResolver",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  apiName: string;
  resolverName: string;
}

export const GraphQLApiResolverProvider = () =>
  Provider.succeed(GraphQLApiResolver, {
    stables: [
      "resolverName",
      "resolverId",
      "apiName",
      "serviceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      GraphQLApiResolverProps,
      GraphQLApiResolver["Attributes"],
      Key,
      apim.GetGraphQLApiResolverResponse
    >({
      label: (key) =>
        `API Management resolver ${key.resolverName} of API ${key.apiName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            apiName: props.apiName,
            resolverName:
              props.name ??
              output?.resolverName ??
              (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetGraphQLApiResolver({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          apiId: key.apiName,
          resolverId: key.resolverName,
        }),
      put: (subscriptionId, key, news) =>
        apim.GraphQLApiResolverCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          apiId: key.apiName,
          resolverId: key.resolverName,
          properties: {
            path: news.path,
            displayName: news.displayName ?? key.resolverName,
            description: news.description ?? news.path,
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteGraphQLApiResolver({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          apiId: key.apiName,
          resolverId: key.resolverName,
        }),
      inSync: (news, observed) =>
        observed.properties?.path === news.path &&
        observed.properties.displayName ===
          (news.displayName ?? observed.name) &&
        observed.properties.description === (news.description ?? news.path),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        apiName: key.apiName,
        resolverName: key.resolverName,
        resolverId: observed.id ?? "",
        path: observed.properties?.path ?? "",
      }),
    }),
  });
