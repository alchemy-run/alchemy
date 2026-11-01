import * as management from "@distilled.cloud/stackit/rabbitmq_management";
import * as Layer from "effect/Layer";
import { makeVhostHttpBinding } from "./BindingHttp.ts";
import { ListQueues } from "./ListQueues.ts";

/**
 * HTTP implementation of {@link ListQueues}.
 *
 * @layer
 * @provides Stackit.RabbitMQ.ListQueues
 */
export const ListQueuesHttp = Layer.succeed(
  ListQueues,
  makeVhostHttpBinding({
    tag: "Stackit.RabbitMQ.ListQueues",
    operation: management.listQueues,
  }),
);
