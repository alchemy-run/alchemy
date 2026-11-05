import * as iotw from "@distilled.cloud/aws/iot-wireless";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeIotWirelessDeviceHttpBinding } from "./BindingHttp.ts";
import type { WirelessDevice } from "./WirelessDevice.ts";

/**
 * Request for {@link UpdateResourcePosition}. The bound device's id and the
 * `WirelessDevice` resource type are injected automatically; supply the
 * GeoJSON position payload (a string is accepted directly).
 */
export interface UpdateResourcePositionRequest extends Omit<
  iotw.UpdateResourcePositionRequest,
  "ResourceIdentifier" | "ResourceType"
> {}

/**
 * Runtime binding for `iotwireless:UpdateResourcePosition` — set the bound
 * wireless device's static position (WGS84, as a GeoJSON payload) from a
 * deployed Lambda or Task.
 *
 * ### Updating Device Position
 * Provide the `UpdateResourcePositionHttp` implementation layer on the
 * Function effect, bind the device in the init phase, then call the
 * returned client at runtime.
 *
 * **Example:** Set a Static GeoJSON Position
 * ```typescript
 * // init
 * const updatePosition = yield* AWS.IoTWireless.UpdateResourcePosition(device);
 *
 * // runtime — coordinates are [longitude, latitude, altitude]
 * yield* updatePosition({
 *   GeoJsonPayload: JSON.stringify({
 *     type: "Point",
 *     coordinates: [-122.33, 47.61, 10],
 *   }),
 * });
 * // on the Function effect:
 * // .pipe(Effect.provide(AWS.IoTWireless.UpdateResourcePositionHttp))
 * ```
 *
 * @binding
 */
export interface UpdateResourcePosition extends Binding.Service<
  UpdateResourcePosition,
  "AWS.IoTWireless.UpdateResourcePosition",
  (
    device: WirelessDevice,
  ) => Effect.Effect<
    (
      request: UpdateResourcePositionRequest,
    ) => Effect.Effect<iotw.UpdateResourcePositionResponse, iotw.UpdateResourcePositionError>
  >
> {}
export const UpdateResourcePosition = Binding.Service<UpdateResourcePosition>(
  "AWS.IoTWireless.UpdateResourcePosition",
);

export const UpdateResourcePositionHttp = Layer.effect(
  UpdateResourcePosition,
  makeIotWirelessDeviceHttpBinding({
    capability: "UpdateResourcePosition",
    iamActions: ["iotwireless:UpdateResourcePosition"],
    // IoT Wireless authorizes the position APIs against a type-level ARN
    // (…:WirelessDevice/WirelessDevice) — the device ARN never matches.
    resourceScope: "any",
    operation: iotw.updateResourcePosition,
    prepare: (request: UpdateResourcePositionRequest, wirelessDeviceId) => ({
      ...request,
      ResourceIdentifier: wirelessDeviceId,
      ResourceType: "WirelessDevice" as const,
    }),
  }),
);
