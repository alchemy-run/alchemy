import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { sameName } from "./Common.ts";
import { entityLifecycle, serviceEntityId } from "./Entity.ts";

export interface WorkspaceGroupUserProps {
  /** Resource group of the API Management service. Changing it replaces the membership. */
  resourceGroup: string;
  /** API Management service that holds the group and user. Changing it replaces the membership. */
  serviceName: string;
  /** Workspace that holds the entity (`Workspace.workspaceName`). Changing it replaces the entity. */
  workspaceName: string;
  /** Identifier of the {@link Group}. Changing it replaces the membership. */
  groupName: string;
  /** Identifier of the {@link User}. Changing it replaces the membership. */
  userName: string;
}

export interface WorkspaceGroupUser extends Resource<
  "Azure.ApiManagement.WorkspaceGroupUser",
  WorkspaceGroupUserProps,
  {
    /** ARM resource ID of the membership. */
    groupUserId: string;
    /** Identifier of the group. */
    groupName: string;
    /** Identifier of the user. */
    userName: string;
    /** API Management service that holds the group and user. */
    serviceName: string;
    /** Workspace that holds the entity. */
    workspaceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
  },
  never,
  Providers
> {}

/**
 * The workspace-scoped counterpart of {@link GroupUser}: the same entity inside
 * an API Management {@link Workspace} (Premium and v2 tiers).
 *
 * Adds a {@link User} to a custom {@link Group} of an API Management
 * service, giving the user visibility of the products the group can see.
 * The membership has no settings; changing the group or user replaces it.
 * Not available on the Consumption tier.
 *
 * @see https://learn.microsoft.com/azure/api-management/api-management-howto-create-groups
 *
 * ### Managing Group Membership
 * **Example:** Add a developer to the partners group
 * ```typescript
 * yield* Azure.ApiManagement.WorkspaceGroupUser("jane-partners", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   groupName: partners.groupName,
 *   userName: jane.userName,
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceGroupUser = Resource<WorkspaceGroupUser>(
  "Azure.ApiManagement.WorkspaceGroupUser",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  groupName: string;
  userName: string;
}

export const WorkspaceGroupUserProvider = () =>
  Provider.succeed(WorkspaceGroupUser, {
    stables: [
      "groupUserId",
      "groupName",
      "userName",
      "serviceName",
      "workspaceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      WorkspaceGroupUserProps,
      WorkspaceGroupUser["Attributes"],
      Key,
      apim.UserContract
    >({
      label: (key) =>
        `API Management user ${key.userName} in group ${key.groupName}`,
      keyOf: (props) =>
        Effect.succeed({
          resourceGroup: props.resourceGroup,
          serviceName: props.serviceName,
          workspaceName: props.workspaceName,
          groupName: props.groupName,
          userName: props.userName,
        }),
      keyOfAttrs: (attrs) => attrs,
      // There is no GET for one membership; the exact-name filter matches at
      // most one user, so the first page is authoritative.
      get: (subscriptionId, key) =>
        apim
          .ListGroupUser({
            subscriptionId,
            resourceGroupName: key.resourceGroup,
            serviceName: key.serviceName,
            workspaceId: key.workspaceName,
            groupId: key.groupName,
            _filter: `name eq '${key.userName}'`,
          })
          .pipe(
            Effect.map((page) =>
              page.value?.find((user) => sameName(user.name, key.userName)),
            ),
          ),
      put: (subscriptionId, key) =>
        apim.CreateWorkspaceGroupUser({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          groupId: key.groupName,
          userId: key.userName,
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteWorkspaceGroupUser({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          groupId: key.groupName,
          userId: key.userName,
        }),
      toAttrs: (subscriptionId, key) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        workspaceName: key.workspaceName,
        groupName: key.groupName,
        userName: key.userName,
        groupUserId: serviceEntityId(
          subscriptionId,
          key,
          `workspaces/${key.workspaceName}/groups/${key.groupName}/users/${key.userName}`,
        ),
      }),
    }),
  });
