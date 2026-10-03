import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { Group, GroupProps } from "./Group.ts";
import { createEntityName } from "./Common.ts";
import { entityLifecycle } from "./Entity.ts";

export interface WorkspaceGroupProps extends GroupProps {
  /** Workspace that holds the group (`Workspace.workspaceName`). Changing it replaces the group. */
  workspaceName: string;
}

export interface WorkspaceGroup extends Resource<
  "Azure.ApiManagement.WorkspaceGroup",
  WorkspaceGroupProps,
  Group["Attributes"] & {
    /** Workspace that holds the group. */
    workspaceName: string;
  },
  never,
  Providers
> {}

/**
 * The workspace-scoped counterpart of {@link Group}: a developer group inside an API
 * Management {@link Workspace} (Premium and v2 tiers). Props and
 * attributes match {@link Group} plus `workspaceName`.
 *
 * @see https://learn.microsoft.com/azure/api-management/workspaces-overview
 *
 * ### Workspace Groups
 * **Example:** A custom group
 * ```typescript
 * yield* Azure.ApiManagement.WorkspaceGroup("partners", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   displayName: "Partners",
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceGroup = Resource<WorkspaceGroup>(
  "Azure.ApiManagement.WorkspaceGroup",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  groupName: string;
}

const where = (subscriptionId: string, key: Key) => ({
  subscriptionId,
  resourceGroupName: key.resourceGroup,
  serviceName: key.serviceName,
  workspaceId: key.workspaceName,
  groupId: key.groupName,
});

export const WorkspaceGroupProvider = () =>
  Provider.succeed(WorkspaceGroup, {
    stables: [
      "groupName",
      "groupId",
      "serviceName",
      "workspaceName",
      "resourceGroup",
      "type",
    ],
    ...entityLifecycle<
      WorkspaceGroupProps,
      WorkspaceGroup["Attributes"],
      Key,
      apim.GetWorkspaceGroupResponse
    >({
      label: (key) => `API Management workspace group ${key.groupName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            workspaceName: props.workspaceName,
            groupName:
              props.name ?? output?.groupName ?? (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetWorkspaceGroup({
          ...where(subscriptionId, key),
        }),
      put: (subscriptionId, key, news) =>
        apim.WorkspaceGroupCreateOrUpdate({
          ...where(subscriptionId, key),
          properties: {
            displayName: news.displayName ?? key.groupName,
            description: news.description,
            type: news.type ?? "custom",
            externalId: news.externalId,
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteWorkspaceGroup({
          ...where(subscriptionId, key),
        }),
      inSync: (news, observed) => {
        const props = observed.properties;
        return (
          props !== undefined &&
          props.displayName === (news.displayName ?? observed.name) &&
          (news.description === undefined ||
            props.description === news.description) &&
          props.type === (news.type ?? "custom") &&
          (news.externalId === undefined ||
            props.externalId === news.externalId)
        );
      },
      // Type and external id cannot change in place.
      replaceOn: (news, olds, output) =>
        (news.type ?? "custom") !== output.type ||
        (olds !== undefined && news.externalId !== olds.externalId),
      isSystem: (observed) => observed.properties?.builtIn === true,
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        workspaceName: key.workspaceName,
        groupName: key.groupName,
        groupId: observed.id ?? "",
        displayName: observed.properties?.displayName ?? key.groupName,
        type: observed.properties?.type ?? "custom",
      }),
    }),
  });
