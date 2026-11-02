import * as management from "@distilled.cloud/stackit/rabbitmq_management";
import * as Layer from "effect/Layer";
import { makeVhostHttpBinding } from "./BindingHttp.ts";
import { DeleteQueue } from "./DeleteQueue.ts";

/**
 * HTTP implementation of {@link DeleteQueue}.
 *
 * @layer
 * @provides Stackit.RabbitMQ.DeleteQueue
 */
export const DeleteQueueHttp = Layer.succeed(
  DeleteQueue,
  makeVhostHttpBinding({
    tag: "Stackit.RabbitMQ.DeleteQueue",
    operation: management.deleteQueue,
  }),
);
