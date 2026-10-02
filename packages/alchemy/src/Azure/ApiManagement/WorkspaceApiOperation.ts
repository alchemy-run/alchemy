import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { ApiOperation, ApiOperationProps } from "./ApiOperation.ts";
import { createEntityName, subsetMatches } from "./Common.ts";
import { entityLifecycle } from "./Entity.ts";

export interface WorkspaceApiOperationProps extends ApiOperationProps {
  /** Workspace that holds the operation (`Workspace.workspaceName`). Changing it replaces the operation. */
  workspaceName: string;
}

export interface WorkspaceApiOperation extends Resource<
  "Azure.ApiManagement.WorkspaceApiOperation",
  WorkspaceApiOperationProps,
  ApiOperation["Attributes"] & {
    /** Workspace that holds the operation. */
    workspaceName: string;
  },
  never,
  Providers
> {}

/**
 * The workspace-scoped counterpart of {@link ApiOperation}: an API operation inside an API
 * Management {@link Workspace} (Premium and v2 tiers). Props and
 * attributes match {@link ApiOperation} plus `workspaceName`.
 *
 * @see https://learn.microsoft.com/azure/api-management/workspaces-overview
 *
 * ### Workspace Operations
 * **Example:** GET /orders/{id}
 * ```typescript
 * yield* Azure.ApiManagement.WorkspaceApiOperation("get-order", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   apiName: api.apiName,
 *   method: "GET",
 *   urlTemplate: "/orders/{id}",
 *   templateParameters: [{ name: "id", type: "string", required: true }],
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceApiOperation = Resource<WorkspaceApiOperation>(
  "Azure.ApiManagement.WorkspaceApiOperation",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  apiName: string;
  operationName: string;
}

const where = (subscriptionId: string, key: Key) => ({
  subscriptionId,
  resourceGroupName: key.resourceGroup,
  serviceName: key.serviceName,
  workspaceId: key.workspaceName,
  apiId: key.apiName,
  operationId: key.operationName,
});

const desiredOf = (
  news: WorkspaceApiOperationProps,
  name: string,
): apim.OperationContractProperties => ({
  displayName: news.displayName ?? name,
  method: news.method.toUpperCase(),
  urlTemplate: news.urlTemplate,
  description: news.description,
  templateParameters: news.templateParameters,
  request: news.request,
  responses: news.responses,
});

export const WorkspaceApiOperationProvider = () =>
  Provider.succeed(WorkspaceApiOperation, {
    stables: [
      "operationName",
      "operationId",
      "apiName",
      "serviceName",
      "workspaceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      WorkspaceApiOperationProps,
      WorkspaceApiOperation["Attributes"],
      Key,
      apim.GetWorkspaceApiOperationResponse
    >({
      label: (key) => `API Management workspace operation ${key.operationName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            workspaceName: props.workspaceName,
            apiName: props.apiName,
            operationName:
              props.name ??
              output?.operationName ??
              (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetWorkspaceApiOperation({
          ...where(subscriptionId, key),
        }),
      put: (subscriptionId, key, news) =>
        apim.WorkspaceApiOperationCreateOrUpdate({
          ...where(subscriptionId, key),
          properties: desiredOf(news, key.operationName),
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteWorkspaceApiOperation({
          ...where(subscriptionId, key),
        }),
      inSync: (news, observed) =>
        subsetMatches(
          desiredOf(news, observed.name ?? ""),
          observed.properties,
        ),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        workspaceName: key.workspaceName,
        apiName: key.apiName,
        operationName: key.operationName,
        operationId: observed.id ?? "",
        method: observed.properties?.method ?? "",
        urlTemplate: observed.properties?.urlTemplate ?? "",
        displayName: observed.properties?.displayName ?? key.operationName,
      }),
    }),
  });
