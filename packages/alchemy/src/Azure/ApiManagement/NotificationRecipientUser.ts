import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { entityLifecycle, serviceEntityId } from "./Entity.ts";
import type { NotificationName } from "./Notification.ts";

export interface NotificationRecipientUserProps {
  /** Resource group of the API Management service. Changing it replaces the recipient. */
  resourceGroup: string;
  /** API Management service that sends the notification. Changing it replaces the recipient. */
  serviceName: string;
  /** Notification to subscribe the user to. Changing it replaces the recipient. */
  notificationName: NotificationName;
  /** Identifier of the {@link User} that receives the notification. Changing it replaces the recipient. */
  userName: string;
}

export interface NotificationRecipientUser extends Resource<
  "Azure.ApiManagement.NotificationRecipientUser",
  NotificationRecipientUserProps,
  {
    /** ARM resource ID of the recipient. */
    recipientId: string;
    /** Notification name. */
    notificationName: string;
    /** Identifier of the recipient user. */
    userName: string;
    /** API Management service that sends the notification. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
  },
  never,
  Providers
> {}

/**
 * Subscribes an API Management {@link User} to a publisher
 * {@link Notification}. The subscription has no settings; changing the
 * notification or user replaces it. Not available on the Consumption
 * tier.
 *
 * @see https://learn.microsoft.com/azure/api-management/api-management-howto-configure-notifications
 *
 * ### Subscribing a User
 * **Example:** Send quota warnings to an operator account
 * ```typescript
 * yield* Azure.ApiManagement.NotificationRecipientUser("quota-ops", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   notificationName: "QuotaLimitApproachingPublisherNotificationMessage",
 *   userName: operator.userName,
 * });
 * ```
 *
 * @resource
 */
export const NotificationRecipientUser = Resource<NotificationRecipientUser>(
  "Azure.ApiManagement.NotificationRecipientUser",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  notificationName: string;
  userName: string;
}

export const NotificationRecipientUserProvider = () =>
  Provider.succeed(NotificationRecipientUser, {
    stables: [
      "recipientId",
      "notificationName",
      "userName",
      "serviceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      NotificationRecipientUserProps,
      NotificationRecipientUser["Attributes"],
      Key,
      apim.RecipientUserContract
    >({
      label: (key) =>
        `API Management recipient ${key.userName} of notification ${key.notificationName}`,
      keyOf: (props) =>
        Effect.succeed({
          resourceGroup: props.resourceGroup,
          serviceName: props.serviceName,
          notificationName: props.notificationName,
          userName: props.userName,
        }),
      keyOfAttrs: (attrs) => attrs,
      // There is no GET for one recipient; a notification has a handful of
      // recipients, so the first page is authoritative. `userId` is the
      // user's service-relative id (`/users/{userId}`).
      get: (subscriptionId, key) =>
        apim
          .ListNotificationRecipientUserByNotification({
            subscriptionId,
            resourceGroupName: key.resourceGroup,
            serviceName: key.serviceName,
            notificationName: key.notificationName,
          })
          .pipe(
            Effect.map((page) =>
              page.value?.find(
                (recipient) =>
                  recipient.properties?.userId
                    ?.split("/")
                    .pop()
                    ?.toLowerCase() === key.userName.toLowerCase(),
              ),
            ),
          ),
      put: (subscriptionId, key) =>
        apim.NotificationRecipientUserCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          notificationName: key.notificationName,
          userId: key.userName,
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteNotificationRecipientUser({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          notificationName: key.notificationName,
          userId: key.userName,
        }),
      toAttrs: (subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        notificationName: key.notificationName,
        userName: key.userName,
        recipientId:
          observed.id ??
          serviceEntityId(
            subscriptionId,
            key,
            `notifications/${key.notificationName}/recipientUsers/${key.userName}`,
          ),
      }),
    }),
  });
