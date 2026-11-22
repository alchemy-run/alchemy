import * as apim from "@distilled.cloud/azure/apimanagement";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound, waitUntilGone } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { createEntityName, isParentOwned, sameName, subsetMatches } from "./Common.ts";

export type ApiOperationParameter = apim.ParameterContract;
export type ApiOperationRequest = apim.RequestContract;
export type ApiOperationResponse = apim.ResponseContract;

export interface ApiOperationProps {
  /** Resource group of the API Management service. Changing it replaces the operation. */
  resourceGroup: string;
  /** API Management service that holds the API. Changing it replaces the operation. */
  serviceName: string;
  /** API identifier (`Api.apiName`). Changing it replaces the operation. */
  apiName: string;
  /**
   * Operation identifier (1-80 characters). If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces
   * the operation.
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Display name.
   * @default the operation identifier
   */
  displayName?: string;
  /** HTTP method, e.g. `GET` or `POST`. */
  method: string;
  /**
   * Relative URL template, e.g. `/users/{id}`. Every `{param}` needs a
   * matching entry in `templateParameters`.
   */
  urlTemplate: string;
  /**
   * Description; may contain HTML.
   * @default no description
   */
  description?: string;
  /**
   * Parameters of the URL template.
   * @default none
   */
  templateParameters?: ApiOperationParameter[];
  /**
   * Request details (query parameters, headers, representations).
   * @default not set
   */
  request?: ApiOperationRequest;
  /**
   * Documented responses.
   * @default none
   */
  responses?: ApiOperationResponse[];
}

export interface ApiOperation extends Resource<
  "Azure.ApiManagement.ApiOperation",
  ApiOperationProps,
  {
    /** Operation identifier. */
    operationName: string;
    /** ARM resource ID of the operation. */
    operationId: string;
    /** API identifier. */
    apiName: string;
    /** API Management service that holds the API. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** HTTP method. */
    method: string;
    /** Relative URL template. */
    urlTemplate: string;
    /** Display name. */
    displayName: string;
  },
  never,
  Providers
> {}

/**
 * An operation (method + URL template) of an API Management API.
 * The ARM type is `Microsoft.ApiManagement/service/apis/operations`.
 *
 * :::caution
 * Changing `serviceName`, `apiName`, `name`, or `resourceGroup` replaces the
 * operation.
 * :::
 *
 * @see https://learn.microsoft.com/azure/api-management/add-api-manually#add-an-operation
 *
 * ### Creating an Operation
 * **Example:** GET operation
 * ```typescript
 * const apim = yield* Azure.ApiManagement.Service("gateway", {
 *   publisherEmail: "ops@example.com",
 *   publisherName: "Example Inc",
 * });
 * const api = yield* Azure.ApiManagement.Api("orders", {
 *   serviceName: apim.serviceName,
 *   path: "orders",
 *   serviceUrl: "https://orders.example.com",
 * });
 * const hello = yield* Azure.ApiManagement.ApiOperation("hello", {
 *   serviceName: apim.serviceName,
 *   apiName: api.apiName,
 *   method: "GET",
 *   urlTemplate: "/hello",
 * });
 * ```
 *
 * **Example:** Operation with a path parameter
 * ```typescript
 * const apim = yield* Azure.ApiManagement.Service("gateway", {
 *   publisherEmail: "ops@example.com",
 *   publisherName: "Example Inc",
 * });
 * const api = yield* Azure.ApiManagement.Api("orders", {
 *   serviceName: apim.serviceName,
 *   path: "orders",
 *   serviceUrl: "https://orders.example.com",
 * });
 * const getUser = yield* Azure.ApiManagement.ApiOperation("get-user", {
 *   serviceName: apim.serviceName,
 *   apiName: api.apiName,
 *   displayName: "Get user",
 *   method: "GET",
 *   urlTemplate: "/users/{id}",
 *   templateParameters: [{ name: "id", type: "string", required: true }],
 *   responses: [{ statusCode: 200, description: "The user" }],
 * });
 * ```
 *
 * @resource
 */
export const ApiOperation = GroupedResource<ApiOperation>("Azure.ApiManagement.ApiOperation");

const getOperation = (
  subscriptionId: string,
  resourceGroupName: string,
  serviceName: string,
  apiId: string,
  operationId: string,
) =>
  orUndefinedIfNotFound(
    apim.GetApiOperation({
      subscriptionId,
      resourceGroupName,
      serviceName,
      apiId,
      operationId,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  serviceName: string,
  apiName: string,
  name: string,
  operation: apim.GetApiOperationResponse,
): ApiOperation["Attributes"] => ({
  operationName: name,
  operationId: operation.id ?? "",
  apiName,
  serviceName,
  resourceGroup,
  method: operation.properties?.method ?? "",
  urlTemplate: operation.properties?.urlTemplate ?? "",
  displayName: operation.properties?.displayName ?? name,
});

export const ApiOperationProvider = () =>
  Provider.succeed(ApiOperation, {
    stables: ["operationName", "operationId", "apiName", "serviceName", "resourceGroup"],

    // Operations live inside an API; nuke removes them with the service.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.serviceName, output.serviceName) ||
        !sameName(news.apiName, output.apiName) ||
        (news.name !== undefined && !sameName(news.name, output.operationName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serviceName = output?.serviceName ?? olds?.serviceName;
      const apiName = output?.apiName ?? olds?.apiName;
      if (resourceGroup === undefined || serviceName === undefined || apiName === undefined) {
        return undefined;
      }
      const name = output?.operationName ?? olds?.name ?? (yield* createEntityName(id));
      const observed = yield* getOperation(
        subscriptionId,
        resourceGroup,
        serviceName,
        apiName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, serviceName, apiName, name, observed);
      return (yield* isParentOwned(subscriptionId, resourceGroup, serviceName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ApiManagement");
      const { resourceGroup, serviceName, apiName } = news;
      const name = news.name ?? output?.operationName ?? (yield* createEntityName(id));
      const desired: apim.OperationContractProperties = {
        displayName: news.displayName ?? name,
        method: news.method.toUpperCase(),
        urlTemplate: news.urlTemplate,
        description: news.description,
        templateParameters: news.templateParameters,
        request: news.request,
        responses: news.responses,
      };

      // Observe, then create or sync with one upsert when anything differs.
      const observed = yield* getOperation(
        subscriptionId,
        resourceGroup,
        serviceName,
        apiName,
        name,
      );
      const current =
        observed !== undefined && subsetMatches(desired, observed.properties)
          ? observed
          : yield* apim.ApiOperationCreateOrUpdate({
              subscriptionId,
              resourceGroupName: resourceGroup,
              serviceName,
              apiId: apiName,
              operationId: name,
              properties: desired,
            });
      return toAttrs(resourceGroup, serviceName, apiName, name, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        apim.DeleteApiOperation({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serviceName: output.serviceName,
          apiId: output.apiName,
          operationId: output.operationName,
        }),
      );
      yield* waitUntilGone(
        `API Management operation ${output.operationName}`,
        getOperation(
          subscriptionId,
          output.resourceGroup,
          output.serviceName,
          output.apiName,
          output.operationName,
        ),
        { interval: "2 seconds", times: 15 },
      );
    }),
  });
