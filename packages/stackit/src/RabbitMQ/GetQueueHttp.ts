import * as management from "@distilled.cloud/stackit/rabbitmq_management";
import * as Layer from "effect/Layer";
import { makeVhostHttpBinding } from "./BindingHttp.ts";
import { GetQueue } from "./GetQueue.ts";

/**
 * HTTP implementation of {@link GetQueue}.
 *
 * @layer
 * @provides Stackit.RabbitMQ.GetQueue
 */
export const GetQueueHttp = Layer.succeed(
  GetQueue,
  makeVhostHttpBinding({
    tag: "Stackit.RabbitMQ.GetQueue",
    operation: management.getQueue,
  }),
);
