import * as notifications from "@distilled.cloud/aws/notifications";
import * as Layer from "effect/Layer";
import { makeNotificationsHttpBinding } from "./BindingHttp.ts";
import { GetManagedNotificationConfiguration } from "./GetManagedNotificationConfiguration.ts";

export const GetManagedNotificationConfigurationHttp = Layer.effect(
  GetManagedNotificationConfiguration,
  makeNotificationsHttpBinding<
    notifications.GetManagedNotificationConfigurationRequest,
    notifications.GetManagedNotificationConfigurationResponse,
    notifications.GetManagedNotificationConfigurationError
  >({
    capability: "GetManagedNotificationConfiguration",
    iamActions: ["notifications:GetManagedNotificationConfiguration"],
    operation: notifications.getManagedNotificationConfiguration,
  }),
);
