import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { ApiVersionSet, ApiVersionSetProps } from "./ApiVersionSet.ts";
import { createEntityName, subsetMatches } from "./Common.ts";
import { entityLifecycle } from "./Entity.ts";

export interface WorkspaceApiVersionSetProps extends ApiVersionSetProps {
  /** Workspace that holds the version set (`Workspace.workspaceName`). Changing it replaces the version set. */
  workspaceName: string;
}

export interface WorkspaceApiVersionSet extends Resource<
  "Azure.ApiManagement.WorkspaceApiVersionSet",
  WorkspaceApiVersionSetProps,
  ApiVersionSet["Attributes"] & {
    /** Workspace that holds the version set. */
    workspaceName: string;
  },
  never,
  Providers
> {}

/**
 * The workspace-scoped counterpart of {@link ApiVersionSet}: an API version set inside an API
 * Management {@link Workspace} (Premium and v2 tiers). Props and
 * attributes match {@link ApiVersionSet} plus `workspaceName`.
 *
 * @see https://learn.microsoft.com/azure/api-management/workspaces-overview
 *
 * ### Workspace Version Sets
 * **Example:** Version APIs by path segment
 * ```typescript
 * yield* Azure.ApiManagement.WorkspaceApiVersionSet("orders-versions", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   displayName: "Orders",
 *   versioningScheme: "Segment",
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceApiVersionSet = Resource<WorkspaceApiVersionSet>(
  "Azure.ApiManagement.WorkspaceApiVersionSet",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  versionSetName: string;
}

const where = (subscriptionId: string, key: Key) => ({
  subscriptionId,
  resourceGroupName: key.resourceGroup,
  serviceName: key.serviceName,
  workspaceId: key.workspaceName,
  versionSetId: key.versionSetName,
});

const desiredOf = (
  news: WorkspaceApiVersionSetProps,
  name: string,
): apim.ApiVersionSetContractProperties => ({
  displayName: news.displayName ?? name,
  versioningScheme: news.versioningScheme,
  versionQueryName: news.versionQueryName,
  versionHeaderName: news.versionHeaderName,
  description: news.description,
});

export const WorkspaceApiVersionSetProvider = () =>
  Provider.succeed(WorkspaceApiVersionSet, {
    stables: [
      "versionSetName",
      "versionSetId",
      "serviceName",
      "workspaceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      WorkspaceApiVersionSetProps,
      WorkspaceApiVersionSet["Attributes"],
      Key,
      apim.GetWorkspaceApiVersionSetResponse
    >({
      label: (key) =>
        `API Management workspace version set ${key.versionSetName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            workspaceName: props.workspaceName,
            versionSetName:
              props.name ??
              output?.versionSetName ??
              (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetWorkspaceApiVersionSet({
          ...where(subscriptionId, key),
        }),
      put: (subscriptionId, key, news) =>
        apim.WorkspaceApiVersionSetCreateOrUpdate({
          ...where(subscriptionId, key),
          properties: desiredOf(news, key.versionSetName),
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteWorkspaceApiVersionSet({
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
        versionSetName: key.versionSetName,
        versionSetId: observed.id ?? "",
        displayName: observed.properties?.displayName ?? key.versionSetName,
        versioningScheme: observed.properties?.versioningScheme ?? "",
      }),
    }),
  });
