import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName } from "./Common.ts";
import { entityLifecycle } from "./Entity.ts";

export interface WorkspaceProps {
  /** Resource group of the API Management service. Changing it replaces the workspace. */
  resourceGroup: string;
  /** API Management service that holds the workspace. Changing it replaces the workspace. */
  serviceName: string;
  /**
   * Workspace identifier, unique within the service. Changing it replaces
   * the workspace.
   * @default a name generated from the stack, stage, and logical ID
   */
  name?: string;
  /**
   * Display name of the workspace.
   * @default the workspace identifier
   */
  displayName?: string;
  /** Description of the workspace. */
  description?: string;
}

export interface Workspace extends Resource<
  "Azure.ApiManagement.Workspace",
  WorkspaceProps,
  {
    /** Workspace identifier within the service. */
    workspaceName: string;
    /** ARM resource ID of the workspace. */
    workspaceId: string;
    /** API Management service that holds the workspace. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Display name of the workspace. */
    displayName: string;
  },
  never,
  Providers
> {}

/**
 * A workspace of an API Management service: an isolated area where a team
 * manages its own APIs, products, subscriptions, backends, and policies
 * (the `Workspace*` resources). Requires the Premium or a v2 tier.
 *
 * @see https://learn.microsoft.com/azure/api-management/workspaces-overview
 *
 * ### Creating Workspaces
 * **Example:** A workspace for one team
 * ```typescript
 * const workspace = yield* Azure.ApiManagement.Workspace("payments", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   displayName: "Payments team",
 *   description: "APIs owned by the payments team",
 * });
 * ```
 *
 * @resource
 */
export const Workspace = Resource<Workspace>("Azure.ApiManagement.Workspace");

interface Key {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
}

export const WorkspaceProvider = () =>
  Provider.succeed(Workspace, {
    stables: ["workspaceName", "workspaceId", "serviceName", "resourceGroup"],
    ...entityLifecycle<
      WorkspaceProps,
      Workspace["Attributes"],
      Key,
      apim.GetWorkspaceResponse
    >({
      label: (key) => `API Management workspace ${key.workspaceName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            workspaceName:
              props.name ??
              output?.workspaceName ??
              (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetWorkspace({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
        }),
      put: (subscriptionId, key, news) =>
        apim.WorkspaceCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          properties: {
            displayName: news.displayName ?? key.workspaceName,
            description: news.description,
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteWorkspace({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
        }),
      inSync: (news, observed) =>
        observed.properties?.displayName ===
          (news.displayName ?? observed.name) &&
        (news.description === undefined ||
          observed.properties?.description === news.description),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        workspaceName: key.workspaceName,
        workspaceId: observed.id ?? "",
        displayName: observed.properties?.displayName ?? key.workspaceName,
      }),
    }),
  });
