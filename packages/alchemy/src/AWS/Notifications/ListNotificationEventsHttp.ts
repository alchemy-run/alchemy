import * as notifications from "@distilled.cloud/aws/notifications";
import * as Layer from "effect/Layer";
import { makeNotificationsHttpBinding } from "./BindingHttp.ts";
import { ListNotificationEvents } from "./ListNotificationEvents.ts";

export const ListNotificationEventsHttp = Layer.effect(
  ListNotificationEvents,
  makeNotificationsHttpBinding<
    notifications.ListNotificationEventsRequest,
    notifications.ListNotificationEventsResponse,
    notifications.ListNotificationEventsError
  >({
    capability: "ListNotificationEvents",
    iamActions: ["notifications:ListNotificationEvents"],
    operation: notifications.listNotificationEvents,
  }),
);
