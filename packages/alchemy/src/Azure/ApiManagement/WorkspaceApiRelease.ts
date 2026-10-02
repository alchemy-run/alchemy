import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName } from "./Common.ts";
import { entityLifecycle, serviceEntityId } from "./Entity.ts";

export interface WorkspaceApiReleaseProps {
  /** Resource group of the API Management service. Changing it replaces the release. */
  resourceGroup: string;
  /** API Management service that holds the API. Changing it replaces the release. */
  serviceName: string;
  /** Workspace that holds the entity (`Workspace.workspaceName`). Changing it replaces the entity. */
  workspaceName: string;
  /** Identifier of the API (without `;rev=`). Changing it replaces the release. */
  apiName: string;
  /**
   * Release identifier, unique within the API. Changing it replaces the
   * release.
   * @default a name generated from the stack, stage, and logical ID
   */
  name?: string;
  /**
   * API revision to make current, e.g. `"2"`. Creating a release makes that
   * revision the current one. Changing it replaces the release.
   * @default the API's current revision
   */
  apiRevision?: string;
  /** Release notes shown in the developer portal change log. */
  notes?: string;
}

export interface WorkspaceApiRelease extends Resource<
  "Azure.ApiManagement.WorkspaceApiRelease",
  WorkspaceApiReleaseProps,
  {
    /** Release identifier within the API. */
    releaseName: string;
    /** ARM resource ID of the release. */
    releaseId: string;
    /** Identifier of the API. */
    apiName: string;
    /** Released API revision (`undefined` for the current one). */
    apiRevision: string | undefined;
    /** API Management service that holds the API. */
    serviceName: string;
    /** Workspace that holds the entity. */
    workspaceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Release notes. */
    notes: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The workspace-scoped counterpart of {@link ApiRelease}: the same entity inside
 * an API Management {@link Workspace} (Premium and v2 tiers).
 *
 * A release of an API in API Management. Releasing an API revision makes
 * it the current revision and records an entry (with notes) in the API's
 * change log.
 *
 * @see https://learn.microsoft.com/azure/api-management/api-management-revisions
 *
 * ### Releasing Revisions
 * **Example:** Make revision 2 current with release notes
 * ```typescript
 * yield* Azure.ApiManagement.WorkspaceApiRelease("orders-r2", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   apiName: "orders",
 *   apiRevision: "2",
 *   notes: "Adds pagination to GET /orders",
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceApiRelease = Resource<WorkspaceApiRelease>(
  "Azure.ApiManagement.WorkspaceApiRelease",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  apiName: string;
  releaseName: string;
  apiRevision: string | undefined;
}

export const WorkspaceApiReleaseProvider = () =>
  Provider.succeed(WorkspaceApiRelease, {
    stables: [
      "releaseName",
      "releaseId",
      "apiName",
      "serviceName",
      "workspaceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      WorkspaceApiReleaseProps,
      WorkspaceApiRelease["Attributes"],
      Key,
      apim.GetWorkspaceApiReleaseResponse
    >({
      label: (key) =>
        `API Management release ${key.releaseName} of API ${key.apiName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            workspaceName: props.workspaceName,
            apiName: props.apiName,
            apiRevision: props.apiRevision,
            releaseName:
              props.name ??
              output?.releaseName ??
              (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetWorkspaceApiRelease({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          apiId: key.apiName,
          releaseId: key.releaseName,
        }),
      put: (subscriptionId, key, news) =>
        apim.WorkspaceApiReleaseCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          apiId: key.apiName,
          releaseId: key.releaseName,
          properties: {
            apiId: serviceEntityId(
              subscriptionId,
              key,
              key.apiRevision === undefined
                ? `workspaces/${key.workspaceName}/apis/${key.apiName}`
                : `workspaces/${key.workspaceName}/apis/${key.apiName};rev=${key.apiRevision}`,
            ),
            notes: news.notes,
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteWorkspaceApiRelease({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          apiId: key.apiName,
          releaseId: key.releaseName,
        }),
      inSync: (news, observed) =>
        (news.notes ?? "") === (observed.properties?.notes ?? ""),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        workspaceName: key.workspaceName,
        apiName: key.apiName,
        apiRevision: key.apiRevision,
        releaseName: key.releaseName,
        releaseId: observed.id ?? "",
        notes: observed.properties?.notes,
      }),
    }),
  });
