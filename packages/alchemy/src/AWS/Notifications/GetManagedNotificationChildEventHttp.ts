import * as notifications from "@distilled.cloud/aws/notifications";
import * as Layer from "effect/Layer";
import { makeNotificationsHttpBinding } from "./BindingHttp.ts";
import { GetManagedNotificationChildEvent } from "./GetManagedNotificationChildEvent.ts";

export const GetManagedNotificationChildEventHttp = Layer.effect(
  GetManagedNotificationChildEvent,
  makeNotificationsHttpBinding<
    notifications.GetManagedNotificationChildEventRequest,
    notifications.GetManagedNotificationChildEventResponse,
    notifications.GetManagedNotificationChildEventError
  >({
    capability: "GetManagedNotificationChildEvent",
    iamActions: ["notifications:GetManagedNotificationChildEvent"],
    operation: notifications.getManagedNotificationChildEvent,
  }),
);
