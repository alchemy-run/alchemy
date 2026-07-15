import * as notifications from "@distilled.cloud/aws/notifications";
import * as Layer from "effect/Layer";
import { makeNotificationsHttpBinding } from "./BindingHttp.ts";
import { ListManagedNotificationChannelAssociations } from "./ListManagedNotificationChannelAssociations.ts";

export const ListManagedNotificationChannelAssociationsHttp = Layer.effect(
  ListManagedNotificationChannelAssociations,
  makeNotificationsHttpBinding<
    notifications.ListManagedNotificationChannelAssociationsRequest,
    notifications.ListManagedNotificationChannelAssociationsResponse,
    notifications.ListManagedNotificationChannelAssociationsError
  >({
    capability: "ListManagedNotificationChannelAssociations",
    iamActions: ["notifications:ListManagedNotificationChannelAssociations"],
    operation: notifications.listManagedNotificationChannelAssociations,
  }),
);
