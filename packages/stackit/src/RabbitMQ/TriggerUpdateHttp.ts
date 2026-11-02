import * as rabbitmq from "@distilled.cloud/stackit/rabbitmq";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { TriggerUpdate } from "./TriggerUpdate.ts";

/**
 * HTTP implementation of {@link TriggerUpdate}.
 *
 * @layer
 * @provides Stackit.RabbitMQ.TriggerUpdate
 */
export const TriggerUpdateHttp = Layer.effect(
  TriggerUpdate,
  makeInstanceHttpBinding({
    tag: "Stackit.RabbitMQ.TriggerUpdate",
    permission: "rabbitmq.proxy.write",
    operation: rabbitmq.triggerUpdate,
  }),
);
