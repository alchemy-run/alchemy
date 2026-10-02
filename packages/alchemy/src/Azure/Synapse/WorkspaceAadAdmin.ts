import * as synapse from "@distilled.cloud/azure/synapse";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { isWorkspaceOwnedByStack, lower, syncSetting } from "./common.ts";

export interface WorkspaceAadAdminProps {
  /** Resource group of the workspace. Changing it replaces the administrator. */
  resourceGroup: string;
  /** Name of the Synapse workspace. Changing it replaces the administrator. */
  workspace: string;
  /** Display name of the user, group, or application. */
  login: string;
  /**
   * Object ID of the user or group, or the application (client) ID of a
   * service principal or managed identity.
   */
  sid: string;
  /**
   * Entra tenant of the administrator.
   * @default the subscription's tenant
   */
  tenantId?: string;
}

export interface WorkspaceAadAdmin extends Resource<
  "Azure.Synapse.WorkspaceAadAdmin",
  WorkspaceAadAdminProps,
  {
    /** ARM resource ID of the administrator. */
    administratorId: string;
    /** Name of the workspace. */
    workspaceName: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Display name of the administrator. */
    login: string;
    /** Object or application ID of the administrator. */
    sid: string;
    /** Entra tenant of the administrator. */
    tenantId: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The Microsoft Entra administrator of a Synapse workspace's SQL endpoints
 * (dedicated and serverless) — a user, group, or service principal that can
 * create database users for other Entra identities.
 *
 * A workspace has at most one Entra administrator. Azure makes the
 * identity that created the workspace its initial administrator; this
 * resource replaces it. Destroying the resource removes the administrator.
 *
 * @see https://learn.microsoft.com/azure/synapse-analytics/sql/active-directory-authentication
 *
 * ### Setting the Administrator
 * **Example:** Entra group as administrator
 * ```typescript
 * yield* Azure.Synapse.WorkspaceAadAdmin("admin", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   login: "data-admins",
 *   sid: dataAdminsGroupObjectId,
 * });
 * ```
 *
 * **Example:** Managed identity as administrator
 * ```typescript
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("dba", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.Synapse.WorkspaceAadAdmin("admin", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   login: identity.identityName,
 *   sid: identity.principalId,
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceAadAdmin = Resource<WorkspaceAadAdmin>(
  "Azure.Synapse.WorkspaceAadAdmin",
);

type ObservedAdmin = synapse.GetWorkspaceAadAdminResponse;

const getAdmin = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
) =>
  orUndefinedIfNotFound(
    synapse.GetWorkspaceAadAdmin({
      subscriptionId,
      resourceGroupName,
      workspaceName,
    }),
  ).pipe(
    // An unset administrator reads back as an empty shell.
    Effect.map((admin) => (admin?.properties?.sid ? admin : undefined)),
  );

const toAttrs = (
  resourceGroup: string,
  workspaceName: string,
  admin: ObservedAdmin,
): WorkspaceAadAdmin["Attributes"] => ({
  administratorId: admin.id ?? "",
  workspaceName,
  resourceGroup,
  login: admin.properties?.login ?? "",
  sid: admin.properties?.sid ?? "",
  tenantId: admin.properties?.tenantId,
});

const matches = (
  admin: ObservedAdmin,
  login: string,
  sid: string,
  tenantId: string,
) =>
  admin.properties?.login === login &&
  lower(admin.properties?.sid) === lower(sid) &&
  lower(admin.properties?.tenantId) === lower(tenantId);

export const WorkspaceAadAdminProvider = () =>
  Provider.succeed(WorkspaceAadAdmin, {
    stables: ["administratorId", "workspaceName", "resourceGroup"],

    // The administrator lives inside a workspace; nuke removes it with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.workspace) !== lower(output.workspaceName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspaceName ?? olds?.workspace;
      if (resourceGroup === undefined || workspace === undefined) {
        return undefined;
      }
      const observed = yield* getAdmin(
        subscriptionId,
        resourceGroup,
        workspace,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, observed);
      // No tags or markers. Azure makes the workspace creator the initial
      // administrator, so on a workspace this stack owns it is ours to set.
      return output !== undefined ||
        (yield* isWorkspaceOwnedByStack(
          subscriptionId,
          resourceGroup,
          workspace,
        ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Synapse");
      const { resourceGroup, workspace, login, sid } = news;
      const tenantId = news.tenantId ?? env.tenantId;
      const fresh = yield* syncSetting({
        label: `synapse entra administrator on ${workspace}`,
        get: getAdmin(subscriptionId, resourceGroup, workspace),
        matches: (admin) => matches(admin, login, sid, tenantId),
        put: synapse.WorkspaceAadAdminsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          properties: {
            administratorType: "ActiveDirectory",
            login,
            sid,
            tenantId,
          },
        }),
      });
      return toAttrs(resourceGroup, workspace, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        synapse.DeleteWorkspaceAadAdmin({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspaceName,
        }),
      );
      yield* waitUntilGone(
        `synapse entra administrator on ${output.workspaceName}`,
        getAdmin(subscriptionId, output.resourceGroup, output.workspaceName),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
