import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { sameName } from "./Common.ts";
import { entityLifecycle, serviceEntityId } from "./Entity.ts";
import type { NotificationName } from "./Notification.ts";

export interface WorkspaceNotificationRecipientEmailProps {
  /** Resource group of the API Management service. Changing it replaces the recipient. */
  resourceGroup: string;
  /** API Management service that sends the notification. Changing it replaces the recipient. */
  serviceName: string;
  /** Workspace that holds the entity (`Workspace.workspaceName`). Changing it replaces the entity. */
  workspaceName: string;
  /** Notification to subscribe the address to (e.g. `BCC`). Changing it replaces the recipient. */
  notificationName: NotificationName;
  /** Email address that receives the notification. Changing it replaces the recipient. */
  email: string;
}

export interface WorkspaceNotificationRecipientEmail extends Resource<
  "Azure.ApiManagement.WorkspaceNotificationRecipientEmail",
  WorkspaceNotificationRecipientEmailProps,
  {
    /** ARM resource ID of the recipient. */
    recipientId: string;
    /** Notification name. */
    notificationName: string;
    /** Recipient email address. */
    email: string;
    /** API Management service that sends the notification. */
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
 * The workspace-scoped counterpart of {@link NotificationRecipientEmail}: the same entity inside
 * an API Management {@link Workspace} (Premium and v2 tiers).
 *
 * Subscribes an email address to an API Management publisher
 * {@link Notification}. The subscription has no settings; changing the
 * notification or address replaces it. Not available on the Consumption
 * tier.
 *
 * @see https://learn.microsoft.com/azure/api-management/api-management-howto-configure-notifications
 *
 * ### Subscribing an Address
 * **Example:** Notify the API team about new subscriptions
 * ```typescript
 * yield* Azure.ApiManagement.WorkspaceNotificationRecipientEmail("new-subs", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   notificationName: "RequestPublisherNotificationMessage",
 *   email: "api-team@example.com",
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceNotificationRecipientEmail =
  Resource<WorkspaceNotificationRecipientEmail>(
    "Azure.ApiManagement.WorkspaceNotificationRecipientEmail",
  );

interface Key {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  notificationName: string;
  email: string;
}

export const WorkspaceNotificationRecipientEmailProvider = () =>
  Provider.succeed(WorkspaceNotificationRecipientEmail, {
    stables: [
      "recipientId",
      "notificationName",
      "email",
      "serviceName",
      "workspaceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      WorkspaceNotificationRecipientEmailProps,
      WorkspaceNotificationRecipientEmail["Attributes"],
      Key,
      apim.RecipientEmailContract
    >({
      label: (key) =>
        `API Management recipient ${key.email} of notification ${key.notificationName}`,
      keyOf: (props) =>
        Effect.succeed({
          resourceGroup: props.resourceGroup,
          serviceName: props.serviceName,
          workspaceName: props.workspaceName,
          notificationName: props.notificationName,
          email: props.email,
        }),
      keyOfAttrs: (attrs) => attrs,
      // There is no GET for one recipient; a notification has a handful of
      // recipients, so the first page is authoritative.
      get: (subscriptionId, key) =>
        apim
          .ListNotificationRecipientEmailByNotification({
            subscriptionId,
            resourceGroupName: key.resourceGroup,
            serviceName: key.serviceName,
            workspaceId: key.workspaceName,
            notificationName: key.notificationName,
          })
          .pipe(
            Effect.map((page) =>
              page.value?.find((recipient) =>
                sameName(recipient.properties?.email, key.email),
              ),
            ),
          ),
      put: (subscriptionId, key) =>
        apim.WorkspaceNotificationRecipientEmailCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          notificationName: key.notificationName,
          email: key.email,
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteWorkspaceNotificationRecipientEmail({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          notificationName: key.notificationName,
          email: key.email,
        }),
      toAttrs: (subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        workspaceName: key.workspaceName,
        notificationName: key.notificationName,
        email: key.email,
        recipientId:
          observed.id ??
          serviceEntityId(
            subscriptionId,
            key,
            `workspaces/${key.workspaceName}/notifications/${key.notificationName}/recipientEmails/${key.email}`,
          ),
      }),
    }),
  });
