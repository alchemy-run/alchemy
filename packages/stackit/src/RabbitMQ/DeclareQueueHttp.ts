import * as management from "@distilled.cloud/stackit/rabbitmq_management";
import * as Layer from "effect/Layer";
import { makeVhostHttpBinding } from "./BindingHttp.ts";
import { DeclareQueue } from "./DeclareQueue.ts";

/**
 * HTTP implementation of {@link DeclareQueue}.
 *
 * @layer
 * @provides Stackit.RabbitMQ.DeclareQueue
 */
export const DeclareQueueHttp = Layer.succeed(
  DeclareQueue,
  makeVhostHttpBinding({
    tag: "Stackit.RabbitMQ.DeclareQueue",
    operation: management.putQueue,
  }),
);
