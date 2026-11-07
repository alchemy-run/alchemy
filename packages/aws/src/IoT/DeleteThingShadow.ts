import * as iotdata from "@distilled.cloud/aws/iot-data-plane";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeIotThingHttpBinding } from "./BindingHttp.ts";
import type { Thing } from "./Thing.ts";

export interface DeleteThingShadowRequest extends Omit<
  iotdata.DeleteThingShadowRequest,
  "thingName"
> {}

/**
 * Runtime binding for the IoT data-plane `DeleteThingShadow` operation (IAM
 * action `iot:DeleteThingShadow`).
 *
 * Bind it to a {@link Thing} to delete the thing's device shadow — the thing
 * name is injected automatically. Provide the implementation with
 * `Effect.provide(AWS.IoT.DeleteThingShadowHttp)`.
 * ### Device Shadows
 * **Example:** Delete a Named Shadow
 * ```typescript
 * const deleteShadow = yield* AWS.IoT.DeleteThingShadow(thing);
 *
 * yield* deleteShadow({ shadowName: "telemetry" });
 * ```
 *
 * @binding
 */
export interface DeleteThingShadow extends Binding.Service<
  DeleteThingShadow,
  "AWS.IoT.DeleteThingShadow",
  (
    thing: Thing,
  ) => Effect.Effect<
    (
      request?: DeleteThingShadowRequest,
    ) => Effect.Effect<iotdata.DeleteThingShadowResponse, iotdata.DeleteThingShadowError>
  >
> {}

export const DeleteThingShadow = Binding.Service<DeleteThingShadow>("AWS.IoT.DeleteThingShadow");

/**
 * HTTP implementation of the {@link DeleteThingShadow} capability — grants
 * `iot:DeleteThingShadow` on the thing ARN and calls the IoT data-plane
 * `DeleteThingShadow` API.
 */
export const DeleteThingShadowHttp = Layer.effect(
  DeleteThingShadow,
  makeIotThingHttpBinding({
    tag: "AWS.IoT.DeleteThingShadow",
    operation: iotdata.deleteThingShadow,
    actions: ["iot:DeleteThingShadow"],
  }),
);
