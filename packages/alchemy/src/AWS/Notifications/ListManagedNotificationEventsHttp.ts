import * as notifications from "@distilled.cloud/aws/notifications";
import * as Layer from "effect/Layer";
import { makeNotificationsHttpBinding } from "./BindingHttp.ts";
import { ListManagedNotificationEvents } from "./ListManagedNotificationEvents.ts";

export const ListManagedNotificationEventsHttp = Layer.effect(
  ListManagedNotificationEvents,
  makeNotificationsHttpBinding<
    notifications.ListManagedNotificationEventsRequest,
    notifications.ListManagedNotificationEventsResponse,
    notifications.ListManagedNotificationEventsError
  >({
    capability: "ListManagedNotificationEvents",
    iamActions: ["notifications:ListManagedNotificationEvents"],
    operation: notifications.listManagedNotificationEvents,
  }),
);
