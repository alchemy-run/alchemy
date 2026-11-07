import * as iotdata from "@distilled.cloud/aws/iot-data-plane";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeIotClientHttpBinding } from "./BindingHttp.ts";

export interface SendDirectMessageRequest extends iotdata.SendDirectMessageRequest {}

/**
 * Runtime binding for the IoT data-plane `SendDirectMessage` operation (IAM
 * action `iot:SendDirectMessage`).
 *
 * Binding to a client id filter grants `iot:SendDirectMessage` on matching
 * MQTT client ARNs (or all clients when the filter is omitted) and returns
 * a callable that delivers a message directly to a connected client without
 * publishing through a topic. Provide the implementation with
 * `Effect.provide(AWS.IoT.SendDirectMessageHttp)`.
 * ### MQTT Connections
 * **Example:** Send a Command to a Device
 * ```typescript
 * const sendDirectMessage = yield* AWS.IoT.SendDirectMessage("sensor-*");
 *
 * yield* sendDirectMessage({
 *   clientId: "sensor-1",
 *   topic: "commands/reboot",
 *   payload: JSON.stringify({ at: "now" }),
 * });
 * ```
 *
 * @binding
 */
export interface SendDirectMessage extends Binding.Service<
  SendDirectMessage,
  "AWS.IoT.SendDirectMessage",
  (
    clientIdFilter?: string,
  ) => Effect.Effect<
    (
      request: SendDirectMessageRequest,
    ) => Effect.Effect<iotdata.SendDirectMessageResponse, iotdata.SendDirectMessageError>
  >
> {}

export const SendDirectMessage = Binding.Service<SendDirectMessage>("AWS.IoT.SendDirectMessage");

/**
 * HTTP implementation of the {@link SendDirectMessage} capability — grants
 * `iot:SendDirectMessage` on the bound client filter and calls the IoT
 * data-plane `SendDirectMessage` API.
 */
export const SendDirectMessageHttp = Layer.effect(
  SendDirectMessage,
  makeIotClientHttpBinding({
    tag: "AWS.IoT.SendDirectMessage",
    operation: iotdata.sendDirectMessage,
    actions: ["iot:SendDirectMessage"],
  }),
);
