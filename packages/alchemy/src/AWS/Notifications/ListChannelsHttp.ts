import * as notifications from "@distilled.cloud/aws/notifications";
import * as Layer from "effect/Layer";
import { makeNotificationConfigurationHttpBinding } from "./BindingHttp.ts";
import { ListChannels } from "./ListChannels.ts";

export const ListChannelsHttp = Layer.effect(
  ListChannels,
  makeNotificationConfigurationHttpBinding<
    notifications.ListChannelsRequest,
    notifications.ListChannelsResponse,
    notifications.ListChannelsError
  >({
    capability: "ListChannels",
    iamActions: ["notifications:ListChannels"],
    operation: notifications.listChannels,
  }),
);
