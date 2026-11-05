import * as iotdata from "@distilled.cloud/aws/iot-data-plane";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeIotThingHttpBinding } from "./BindingHttp.ts";
import type { Thing } from "./Thing.ts";

export interface UpdateThingShadowRequest extends Omit<
  iotdata.UpdateThingShadowRequest,
  "thingName"
> {}

/**
 * Runtime binding for the IoT data-plane `UpdateThingShadow` operation (IAM
 * action `iot:UpdateThingShadow`).
 *
 * Bind it to a {@link Thing} to write the thing's device shadow — the thing
 * name is injected automatically. Provide the implementation with
 * `Effect.provide(AWS.IoT.UpdateThingShadowHttp)`.
 * ### Device Shadows
 * **Example:** Set Desired State
 * ```typescript
 * const updateShadow = yield* AWS.IoT.UpdateThingShadow(thing);
 *
 * yield* updateShadow({
 *   payload: JSON.stringify({ state: { desired: { led: "on" } } }),
 * });
 * ```
 *
 * **Example:** Write a Named Shadow
 * ```typescript
 * yield* updateShadow({
 *   shadowName: "telemetry",
 *   payload: JSON.stringify({ state: { reported: { t: 22.5 } } }),
 * });
 * ```
 *
 * @binding
 */
export interface UpdateThingShadow extends Binding.Service<
  UpdateThingShadow,
  "AWS.IoT.UpdateThingShadow",
  (
    thing: Thing,
  ) => Effect.Effect<
    (
      request: UpdateThingShadowRequest,
    ) => Effect.Effect<iotdata.UpdateThingShadowResponse, iotdata.UpdateThingShadowError>
  >
> {}

export const UpdateThingShadow = Binding.Service<UpdateThingShadow>("AWS.IoT.UpdateThingShadow");

/**
 * HTTP implementation of the {@link UpdateThingShadow} capability — grants
 * `iot:UpdateThingShadow` on the thing ARN and calls the IoT data-plane
 * `UpdateThingShadow` API.
 */
export const UpdateThingShadowHttp = Layer.effect(
  UpdateThingShadow,
  makeIotThingHttpBinding({
    tag: "AWS.IoT.UpdateThingShadow",
    operation: iotdata.updateThingShadow,
    actions: ["iot:UpdateThingShadow"],
  }),
);
