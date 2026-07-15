import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";
import { DeleteNotificationChannel } from "./DeleteNotificationChannel.ts";

export const DeleteNotificationChannelHttp = Layer.effect(
  DeleteNotificationChannel,
  makeFmsHttpBinding<
    fms.DeleteNotificationChannelRequest,
    fms.DeleteNotificationChannelResponse,
    fms.DeleteNotificationChannelError
  >({
    capability: "DeleteNotificationChannel",
    iamActions: ["fms:DeleteNotificationChannel"],
    operation: fms.deleteNotificationChannel,
  }),
);
