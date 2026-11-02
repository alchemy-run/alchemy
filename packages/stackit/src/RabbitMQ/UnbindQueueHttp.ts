import * as management from "@distilled.cloud/stackit/rabbitmq_management";
import * as Layer from "effect/Layer";
import { makeVhostHttpBinding } from "./BindingHttp.ts";
import { UnbindQueue } from "./UnbindQueue.ts";

/**
 * HTTP implementation of {@link UnbindQueue}.
 *
 * @layer
 * @provides Stackit.RabbitMQ.UnbindQueue
 */
export const UnbindQueueHttp = Layer.succeed(
  UnbindQueue,
  makeVhostHttpBinding({
    tag: "Stackit.RabbitMQ.UnbindQueue",
    operation: management.deleteQueueBinding,
  }),
);
