import type * as iotdata from "@distilled.cloud/aws/iot-data-plane";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface PublishRequest extends iotdata.PublishRequest {}

/**
 * A capability that lets a Function publish MQTT messages to AWS IoT Core
 * topics via the IoT data plane.
 *
 * @binding
 * @section Publishing Messages
 * @example Publish to a Topic
 * ```typescript
 * const publish = yield* Publish("sensors/+/telemetry");
 * // ...at runtime:
 * yield* publish({ topic: "sensors/1/telemetry", payload: JSON.stringify({ t: 22.5 }) });
 * ```
 */
export interface Publish extends Binding.Service<
  Publish,
  "AWS.IoT.Publish",
  (
    topicFilter?: string,
  ) => Effect.Effect<
    (
      request: PublishRequest,
    ) => Effect.Effect<iotdata.PublishResponse, iotdata.PublishError>
  >
> {}

export const Publish = Binding.Service<Publish>("AWS.IoT.Publish");
