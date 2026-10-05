import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { Backend, BackendProps } from "./Backend.ts";
import { createEntityName, subsetMatches } from "./Common.ts";
import { entityLifecycle } from "./Entity.ts";

export interface WorkspaceBackendProps extends BackendProps {
  /** Workspace that holds the backend (`Workspace.workspaceName`). Changing it replaces the backend. */
  workspaceName: string;
}

export interface WorkspaceBackend extends Resource<
  "Azure.ApiManagement.WorkspaceBackend",
  WorkspaceBackendProps,
  Backend["Attributes"] & {
    /** Workspace that holds the backend. */
    workspaceName: string;
  },
  never,
  Providers
> {}

/**
 * The workspace-scoped counterpart of {@link Backend}: a backend inside an API
 * Management {@link Workspace} (Premium and v2 tiers). Props and
 * attributes match {@link Backend} plus `workspaceName`.
 *
 * @see https://learn.microsoft.com/azure/api-management/workspaces-overview
 *
 * ### Workspace Backends
 * **Example:** An HTTP backend
 * ```typescript
 * yield* Azure.ApiManagement.WorkspaceBackend("orders-backend", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   url: "https://orders.example.com",
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceBackend = Resource<WorkspaceBackend>(
  "Azure.ApiManagement.WorkspaceBackend",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  backendName: string;
}

const where = (subscriptionId: string, key: Key) => ({
  subscriptionId,
  resourceGroupName: key.resourceGroup,
  serviceName: key.serviceName,
  workspaceId: key.workspaceName,
  backendId: key.backendName,
});

const desiredOf = (
  news: WorkspaceBackendProps,
): apim.BackendContractProperties => {
  const type = news.type ?? "Single";
  return {
    type,
    url: news.url,
    protocol: news.protocol ?? (type === "Single" ? "http" : undefined),
    title: news.title,
    description: news.description,
    resourceId: news.resourceId,
    credentials: news.credentials,
    tls: news.tls,
    pool: news.pool ? { services: news.pool } : undefined,
    circuitBreaker: news.circuitBreaker,
  };
};

export const WorkspaceBackendProvider = () =>
  Provider.succeed(WorkspaceBackend, {
    stables: [
      "backendName",
      "backendId",
      "serviceName",
      "workspaceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      WorkspaceBackendProps,
      WorkspaceBackend["Attributes"],
      Key,
      apim.GetWorkspaceBackendResponse
    >({
      label: (key) => `API Management workspace backend ${key.backendName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            workspaceName: props.workspaceName,
            backendName:
              props.name ??
              output?.backendName ??
              (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetWorkspaceBackend({
          ...where(subscriptionId, key),
        }),
      put: (subscriptionId, key, news) =>
        apim.WorkspaceBackendCreateOrUpdate({
          ...where(subscriptionId, key),
          properties: desiredOf(news),
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteWorkspaceBackend({
          ...where(subscriptionId, key),
        }),
      inSync: (news, observed) =>
        subsetMatches(desiredOf(news), observed.properties),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        workspaceName: key.workspaceName,
        backendName: key.backendName,
        backendId: observed.id ?? "",
        type: observed.properties?.type ?? "Single",
        url: observed.properties?.url,
        protocol: observed.properties?.protocol,
      }),
    }),
  });
