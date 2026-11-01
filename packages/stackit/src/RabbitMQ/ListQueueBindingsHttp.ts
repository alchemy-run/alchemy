import * as management from "@distilled.cloud/stackit/rabbitmq_management";
import * as Layer from "effect/Layer";
import { makeVhostHttpBinding } from "./BindingHttp.ts";
import { ListQueueBindings } from "./ListQueueBindings.ts";

/**
 * HTTP implementation of {@link ListQueueBindings}.
 *
 * @layer
 * @provides Stackit.RabbitMQ.ListQueueBindings
 */
export const ListQueueBindingsHttp = Layer.succeed(
  ListQueueBindings,
  makeVhostHttpBinding({
    tag: "Stackit.RabbitMQ.ListQueueBindings",
    operation: management.listQueueBindings,
  }),
);
