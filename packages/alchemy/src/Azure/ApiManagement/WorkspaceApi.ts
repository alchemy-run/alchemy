import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { Api, ApiProps } from "./Api.ts";
import { createEntityName, subsetMatches } from "./Common.ts";
import { entityLifecycle } from "./Entity.ts";

export interface WorkspaceApiProps extends ApiProps {
  /** Workspace that holds the API (`Workspace.workspaceName`). Changing it replaces the API. */
  workspaceName: string;
}

export interface WorkspaceApi extends Resource<
  "Azure.ApiManagement.WorkspaceApi",
  WorkspaceApiProps,
  Api["Attributes"] & {
    /** Workspace that holds the API. */
    workspaceName: string;
  },
  never,
  Providers
> {}

/**
 * The workspace-scoped counterpart of {@link Api}: an API inside an API
 * Management {@link Workspace} (Premium and v2 tiers). Props and
 * attributes match {@link Api} plus `workspaceName`.
 *
 * @see https://learn.microsoft.com/azure/api-management/workspaces-overview
 *
 * ### Workspace APIs
 * **Example:** An HTTP API owned by a team
 * ```typescript
 * yield* Azure.ApiManagement.WorkspaceApi("orders", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   path: "orders",
 *   serviceUrl: "https://orders.example.com",
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceApi = Resource<WorkspaceApi>(
  "Azure.ApiManagement.WorkspaceApi",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  apiName: string;
}

const where = (subscriptionId: string, key: Key) => ({
  subscriptionId,
  resourceGroupName: key.resourceGroup,
  serviceName: key.serviceName,
  workspaceId: key.workspaceName,
  apiId: key.apiName,
});

const desiredOf = (news: WorkspaceApiProps, name: string) => ({
  path: news.path,
  displayName:
    news.displayName ?? (news.value !== undefined ? undefined : name),
  description: news.description,
  serviceUrl: news.serviceUrl,
  protocols: [...(news.protocols ?? ["https"])].sort(),
  subscriptionRequired: news.subscriptionRequired ?? true,
  subscriptionKeyParameterNames: news.subscriptionKeyParameterNames,
  type: news.type ?? "http",
  apiVersion: news.apiVersion,
  apiVersionSetId: news.apiVersionSetId,
  termsOfServiceUrl: news.termsOfServiceUrl,
});

export const WorkspaceApiProvider = () =>
  Provider.succeed(WorkspaceApi, {
    stables: [
      "apiName",
      "apiId",
      "serviceName",
      "workspaceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      WorkspaceApiProps,
      WorkspaceApi["Attributes"],
      Key,
      apim.GetWorkspaceApiResponse
    >({
      label: (key) => `API Management workspace API ${key.apiName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            workspaceName: props.workspaceName,
            apiName:
              props.name ?? output?.apiName ?? (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetWorkspaceApi({
          ...where(subscriptionId, key),
        }),
      put: (subscriptionId, key, news) =>
        apim.WorkspaceApiCreateOrUpdate({
          ...where(subscriptionId, key),
          properties: {
            ...desiredOf(news, key.apiName),
            value: news.value,
            format: news.format,
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteWorkspaceApi({
          ...where(subscriptionId, key),
        }),
      // An imported definition cannot be read back; the previous props are
      // the only hint that a re-import is needed.
      inSync: (news, observed, olds) =>
        (news.value === undefined ||
          (olds?.value === news.value && olds.format === news.format)) &&
        subsetMatches(desiredOf(news, observed.name ?? ""), {
          ...observed.properties,
          protocols: [...(observed.properties?.protocols ?? [])].sort(),
        }),
      stateOf: (observed) =>
        observed.properties?.provisioningState === "InProgress"
          ? "InProgress"
          : undefined,
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        workspaceName: key.workspaceName,
        apiName: key.apiName,
        apiId: observed.id ?? "",
        path: observed.properties?.path ?? "",
        displayName: observed.properties?.displayName,
        serviceUrl: observed.properties?.serviceUrl,
        type: observed.properties?.type ?? "http",
        apiRevision: observed.properties?.apiRevision,
        isCurrent: observed.properties?.isCurrent ?? true,
      }),
    }),
  });
