import * as iotw from "@distilled.cloud/aws/iot-wireless";
import * as Layer from "effect/Layer";
import { makeIotWirelessDeviceHttpBinding } from "./BindingHttp.ts";
import {
  GetResourcePosition,
  type GetResourcePositionRequest,
} from "./GetResourcePosition.ts";

export const GetResourcePositionHttp = Layer.effect(
  GetResourcePosition,
  makeIotWirelessDeviceHttpBinding({
    capability: "GetResourcePosition",
    iamActions: ["iotwireless:GetResourcePosition"],
    operation: iotw.getResourcePosition,
    prepare: (
      request: GetResourcePositionRequest | undefined,
      wirelessDeviceId,
    ) => ({
      ...request,
      ResourceIdentifier: wirelessDeviceId,
      ResourceType: "WirelessDevice" as const,
    }),
  }),
);
