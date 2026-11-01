import * as management from "@distilled.cloud/stackit/rabbitmq_management";
import * as Layer from "effect/Layer";
import { makeVhostHttpBinding } from "./BindingHttp.ts";
import { PurgeQueue } from "./PurgeQueue.ts";

/**
 * HTTP implementation of {@link PurgeQueue}.
 *
 * @layer
 * @provides Stackit.RabbitMQ.PurgeQueue
 */
export const PurgeQueueHttp = Layer.succeed(
  PurgeQueue,
  makeVhostHttpBinding({
    tag: "Stackit.RabbitMQ.PurgeQueue",
    operation: management.purgeQueue,
  }),
);
