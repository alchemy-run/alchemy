import * as rabbitmq from "@distilled.cloud/stackit/rabbitmq";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { TriggerRestore } from "./TriggerRestore.ts";

/**
 * HTTP implementation of {@link TriggerRestore}.
 *
 * @layer
 * @provides Stackit.RabbitMQ.TriggerRestore
 */
export const TriggerRestoreHttp = Layer.effect(
  TriggerRestore,
  makeInstanceHttpBinding({
    tag: "Stackit.RabbitMQ.TriggerRestore",
    permission: "rabbitmq.proxy.write",
    operation: rabbitmq.triggerRestore,
  }),
);
