import * as rabbitmq from "@distilled.cloud/stackit/rabbitmq";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { TriggerRecreate } from "./TriggerRecreate.ts";

/**
 * HTTP implementation of {@link TriggerRecreate}.
 *
 * @layer
 * @provides Stackit.RabbitMQ.TriggerRecreate
 */
export const TriggerRecreateHttp = Layer.effect(
  TriggerRecreate,
  makeInstanceHttpBinding({
    tag: "Stackit.RabbitMQ.TriggerRecreate",
    permission: "rabbitmq.proxy.write",
    operation: rabbitmq.triggerRecreate,
  }),
);
