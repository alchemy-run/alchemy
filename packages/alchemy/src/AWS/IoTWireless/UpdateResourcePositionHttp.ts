import * as iotw from "@distilled.cloud/aws/iot-wireless";
import * as Layer from "effect/Layer";
import { makeIotWirelessDeviceHttpBinding } from "./BindingHttp.ts";
import {
  UpdateResourcePosition,
  type UpdateResourcePositionRequest,
} from "./UpdateResourcePosition.ts";

export const UpdateResourcePositionHttp = Layer.effect(
  UpdateResourcePosition,
  makeIotWirelessDeviceHttpBinding({
    capability: "UpdateResourcePosition",
    iamActions: ["iotwireless:UpdateResourcePosition"],
    operation: iotw.updateResourcePosition,
    prepare: (request: UpdateResourcePositionRequest, wirelessDeviceId) => ({
      ...request,
      ResourceIdentifier: wirelessDeviceId,
      ResourceType: "WirelessDevice" as const,
    }),
  }),
);
