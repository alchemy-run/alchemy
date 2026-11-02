import * as management from "@distilled.cloud/stackit/rabbitmq_management";
import * as Layer from "effect/Layer";
import { makeVhostHttpBinding } from "./BindingHttp.ts";
import { BindQueue } from "./BindQueue.ts";

/**
 * HTTP implementation of {@link BindQueue}.
 *
 * @layer
 * @provides Stackit.RabbitMQ.BindQueue
 */
export const BindQueueHttp = Layer.succeed(
  BindQueue,
  makeVhostHttpBinding({
    tag: "Stackit.RabbitMQ.BindQueue",
    operation: management.createQueueBinding,
  }),
);
