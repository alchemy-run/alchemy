import * as management from "@distilled.cloud/stackit/rabbitmq_management";
import * as Layer from "effect/Layer";
import { makeVhostHttpBinding } from "./BindingHttp.ts";
import { GetMessages } from "./GetMessages.ts";

/**
 * HTTP implementation of {@link GetMessages}.
 *
 * @layer
 * @provides Stackit.RabbitMQ.GetMessages
 */
export const GetMessagesHttp = Layer.succeed(
  GetMessages,
  makeVhostHttpBinding({
    tag: "Stackit.RabbitMQ.GetMessages",
    operation: management.getMessages,
  }),
);
