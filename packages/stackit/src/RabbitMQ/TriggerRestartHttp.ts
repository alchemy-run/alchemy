import * as rabbitmq from "@distilled.cloud/stackit/rabbitmq";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { TriggerRestart } from "./TriggerRestart.ts";

/**
 * HTTP implementation of {@link TriggerRestart}.
 *
 * @layer
 * @provides Stackit.RabbitMQ.TriggerRestart
 */
export const TriggerRestartHttp = Layer.effect(
  TriggerRestart,
  makeInstanceHttpBinding({
    tag: "Stackit.RabbitMQ.TriggerRestart",
    permission: "rabbitmq.proxy.write",
    operation: rabbitmq.triggerRestart,
  }),
);
