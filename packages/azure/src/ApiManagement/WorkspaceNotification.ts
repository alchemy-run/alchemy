import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { entityLifecycle } from "./Entity.ts";
import type { NotificationName } from "./Notification.ts";

export interface WorkspaceNotificationProps {
  /** Resource group of the API Management service. Changing it replaces the notification. */
  resourceGroup: string;
  /** API Management service that sends the notification. Changing it replaces the notification. */
  serviceName: string;
  /** Workspace that holds the entity (`Workspace.workspaceName`). Changing it replaces the entity. */
  workspaceName: string;
  /**
   * Which publisher notification to manage, e.g. `BCC`,
   * `NewApplicationNotificationMessage`, or
   * `QuotaLimitApproachingPublisherNotificationMessage`. Changing it
   * replaces the notification.
   */
  notificationName: NotificationName;
}

export interface WorkspaceNotification extends Resource<
  "Azure.ApiManagement.WorkspaceNotification",
  WorkspaceNotificationProps,
  {
    /** Notification name. */
    notificationName: string;
    /** ARM resource ID of the notification. */
    notificationId: string;
    /** API Management service that sends the notification. */
    serviceName: string;
    /** Workspace that holds the entity. */
    workspaceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Title of the notification. */
    title: string;
    /** Email recipients currently configured. */
    recipientEmails: string[];
  },
  never,
  Providers
> {}

/**
 * The workspace-scoped counterpart of {@link Notification}: the same entity inside
 * an API Management {@link Workspace} (Premium and v2 tiers).
 * The ARM type is
 * `Microsoft.ApiManagement/service/workspaces/notifications`.
 *
 * One of the fixed publisher notifications of an API Management service
 * (new subscription requests, quota warnings, BCC of developer emails,
 * ...). Notifications always exist and cannot be deleted; this resource
 * ensures the notification and exposes it so recipients can be attached
 * with {@link NotificationRecipientEmail} and
 * {@link NotificationRecipientUser}. Not available on the Consumption tier.
 *
 * :::caution
 * Changing `serviceName`, `workspaceName`, `notificationName`, or
 * `resourceGroup` replaces the notification.
 *
 * Workspaces need a BasicV2, StandardV2, or Premium service ("Method not
 * allowed in Consumption pricing tier").
 * :::
 *
 * @see https://learn.microsoft.com/azure/api-management/api-management-howto-configure-notifications
 *
 * ### Managing Notifications
 * **Example:** BCC every developer email to the API team
 * ```typescript
 * const apim = yield* Azure.ApiManagement.Service("gateway", {
 *   sku: { name: "BasicV2", capacity: 1 },
 *   publisherEmail: "ops@example.com",
 *   publisherName: "Example Inc",
 * });
 * const workspace = yield* Azure.ApiManagement.Workspace("payments", {
 *   serviceName: apim.serviceName,
 * });
 * const bcc = yield* Azure.ApiManagement.WorkspaceNotification("bcc", {
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   notificationName: "BCC",
 * });
 * yield* Azure.ApiManagement.WorkspaceNotificationRecipientEmail("bcc-team", {
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   notificationName: bcc.notificationName,
 *   email: "api-team@example.com",
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceNotification = GroupedResource<WorkspaceNotification>(
  "Azure.ApiManagement.WorkspaceNotification",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  notificationName: string;
}

export const WorkspaceNotificationProvider = () =>
  Provider.succeed(WorkspaceNotification, {
    stables: [
      "notificationName",
      "notificationId",
      "serviceName",
      "workspaceName",
      "resourceGroup",
    ],
    // Notifications always exist and have no DELETE.
    nuke: { singleton: true },
    ...entityLifecycle<
      WorkspaceNotificationProps,
      WorkspaceNotification["Attributes"],
      Key,
      apim.GetWorkspaceNotificationResponse
    >({
      label: (key) => `API Management notification ${key.notificationName}`,
      keyOf: (props) =>
        Effect.succeed({
          resourceGroup: props.resourceGroup,
          serviceName: props.serviceName,
          workspaceName: props.workspaceName,
          notificationName: props.notificationName,
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetWorkspaceNotification({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          notificationName: key.notificationName,
        }),
      put: (subscriptionId, key) =>
        apim.WorkspaceNotificationCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          notificationName: key.notificationName,
        }),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        workspaceName: key.workspaceName,
        notificationName: key.notificationName,
        notificationId: observed.id ?? "",
        title: observed.properties?.title ?? "",
        recipientEmails: [...(observed.properties?.recipients?.emails ?? [])],
      }),
    }),
  });
