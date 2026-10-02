import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { entityLifecycle } from "./Entity.ts";

export type NotificationName =
  apim.NotificationCreateOrUpdateRequestNotificationName;

export interface NotificationProps {
  /** Resource group of the API Management service. Changing it replaces the notification. */
  resourceGroup: string;
  /** API Management service that sends the notification. Changing it replaces the notification. */
  serviceName: string;
  /**
   * Which publisher notification to manage, e.g. `BCC`,
   * `NewApplicationNotificationMessage`, or
   * `QuotaLimitApproachingPublisherNotificationMessage`. Changing it
   * replaces the notification.
   */
  notificationName: NotificationName;
}

export interface Notification extends Resource<
  "Azure.ApiManagement.Notification",
  NotificationProps,
  {
    /** Notification name. */
    notificationName: string;
    /** ARM resource ID of the notification. */
    notificationId: string;
    /** API Management service that sends the notification. */
    serviceName: string;
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
 * One of the fixed publisher notifications of an API Management service
 * (new subscription requests, quota warnings, BCC of developer emails,
 * ...). Notifications always exist and cannot be deleted; this resource
 * ensures the notification and exposes it so recipients can be attached
 * with {@link NotificationRecipientEmail} and
 * {@link NotificationRecipientUser}. Not available on the Consumption tier.
 *
 * @see https://learn.microsoft.com/azure/api-management/api-management-howto-configure-notifications
 *
 * ### Managing Notifications
 * **Example:** BCC every developer email to the API team
 * ```typescript
 * const bcc = yield* Azure.ApiManagement.Notification("bcc", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   notificationName: "BCC",
 * });
 * yield* Azure.ApiManagement.NotificationRecipientEmail("bcc-team", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   notificationName: bcc.notificationName,
 *   email: "api-team@example.com",
 * });
 * ```
 *
 * @resource
 */
export const Notification = Resource<Notification>(
  "Azure.ApiManagement.Notification",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  notificationName: string;
}

export const NotificationProvider = () =>
  Provider.succeed(Notification, {
    stables: [
      "notificationName",
      "notificationId",
      "serviceName",
      "resourceGroup",
    ],
    // Notifications always exist and have no DELETE.
    nuke: { singleton: true },
    ...entityLifecycle<
      NotificationProps,
      Notification["Attributes"],
      Key,
      apim.GetNotificationResponse
    >({
      label: (key) => `API Management notification ${key.notificationName}`,
      keyOf: (props) =>
        Effect.succeed({
          resourceGroup: props.resourceGroup,
          serviceName: props.serviceName,
          notificationName: props.notificationName,
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetNotification({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          notificationName: key.notificationName,
        }),
      put: (subscriptionId, key) =>
        apim.NotificationCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          notificationName: key.notificationName,
        }),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        notificationName: key.notificationName,
        notificationId: observed.id ?? "",
        title: observed.properties?.title ?? "",
        recipientEmails: [...(observed.properties?.recipients?.emails ?? [])],
      }),
    }),
  });
