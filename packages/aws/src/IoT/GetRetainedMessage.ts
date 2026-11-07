import * as iotdata from "@distilled.cloud/aws/iot-data-plane";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeIotTopicHttpBinding } from "./BindingHttp.ts";

export interface GetRetainedMessageRequest extends iotdata.GetRetainedMessageRequest {}

/**
 * Runtime binding for the IoT data-plane `GetRetainedMessage` operation (IAM
 * action `iot:GetRetainedMessage`).
 *
 * Binding to a topic filter grants `iot:GetRetainedMessage` on matching
 * topics (or all topics when the filter is omitted) and returns a callable
 * that reads the retained MQTT message for a concrete topic. Provide the
 * implementation with `Effect.provide(AWS.IoT.GetRetainedMessageHttp)`.
 * ### Retained Messages
 * **Example:** Read a Retained Message
 * ```typescript
 * const getRetained = yield* AWS.IoT.GetRetainedMessage("sensors/*");
 *
 * const { payload } = yield* getRetained({ topic: "sensors/1/state" });
 * ```
 *
 * @binding
 */
export interface GetRetainedMessage extends Binding.Service<
  GetRetainedMessage,
  "AWS.IoT.GetRetainedMessage",
  (
    topicFilter?: string,
  ) => Effect.Effect<
    (
      request: GetRetainedMessageRequest,
    ) => Effect.Effect<iotdata.GetRetainedMessageResponse, iotdata.GetRetainedMessageError>
  >
> {}

export const GetRetainedMessage = Binding.Service<GetRetainedMessage>("AWS.IoT.GetRetainedMessage");

/**
 * HTTP implementation of the {@link GetRetainedMessage} capability — grants
 * `iot:GetRetainedMessage` on the bound topic filter and calls the IoT
 * data-plane `GetRetainedMessage` API.
 */
export const GetRetainedMessageHttp = Layer.effect(
  GetRetainedMessage,
  makeIotTopicHttpBinding({
    tag: "AWS.IoT.GetRetainedMessage",
    operation: iotdata.getRetainedMessage,
    actions: ["iot:GetRetainedMessage"],
  }),
);
