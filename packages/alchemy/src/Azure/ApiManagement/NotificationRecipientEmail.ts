import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { sameName } from "./Common.ts";
import { entityLifecycle, serviceEntityId } from "./Entity.ts";
import type { NotificationName } from "./Notification.ts";

export interface NotificationRecipientEmailProps {
  /** Resource group of the API Management service. Changing it replaces the recipient. */
  resourceGroup: string;
  /** API Management service that sends the notification. Changing it replaces the recipient. */
  serviceName: string;
  /** Notification to subscribe the address to (e.g. `BCC`). Changing it replaces the recipient. */
  notificationName: NotificationName;
  /** Email address that receives the notification. Changing it replaces the recipient. */
  email: string;
}

export interface NotificationRecipientEmail extends Resource<
  "Azure.ApiManagement.NotificationRecipientEmail",
  NotificationRecipientEmailProps,
  {
    /** ARM resource ID of the recipient. */
    recipientId: string;
    /** Notification name. */
    notificationName: string;
    /** Recipient email address. */
    email: string;
    /** API Management service that sends the notification. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
  },
  never,
  Providers
> {}

/**
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
 * yield* Azure.ApiManagement.NotificationRecipientEmail("new-subs", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   notificationName: "RequestPublisherNotificationMessage",
 *   email: "api-team@example.com",
 * });
 * ```
 *
 * @resource
 */
export const NotificationRecipientEmail = Resource<NotificationRecipientEmail>(
  "Azure.ApiManagement.NotificationRecipientEmail",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  notificationName: string;
  email: string;
}

export const NotificationRecipientEmailProvider = () =>
  Provider.succeed(NotificationRecipientEmail, {
    stables: [
      "recipientId",
      "notificationName",
      "email",
      "serviceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      NotificationRecipientEmailProps,
      NotificationRecipientEmail["Attributes"],
      Key,
      apim.RecipientEmailContract
    >({
      label: (key) =>
        `API Management recipient ${key.email} of notification ${key.notificationName}`,
      keyOf: (props) =>
        Effect.succeed({
          resourceGroup: props.resourceGroup,
          serviceName: props.serviceName,
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
        apim.NotificationRecipientEmailCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          notificationName: key.notificationName,
          email: key.email,
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteNotificationRecipientEmail({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          notificationName: key.notificationName,
          email: key.email,
        }),
      toAttrs: (subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        notificationName: key.notificationName,
        email: key.email,
        recipientId:
          observed.id ??
          serviceEntityId(
            subscriptionId,
            key,
            `notifications/${key.notificationName}/recipientEmails/${key.email}`,
          ),
      }),
    }),
  });
