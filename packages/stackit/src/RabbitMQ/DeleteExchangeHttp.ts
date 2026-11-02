import * as management from "@distilled.cloud/stackit/rabbitmq_management";
import * as Layer from "effect/Layer";
import { makeVhostHttpBinding } from "./BindingHttp.ts";
import { DeleteExchange } from "./DeleteExchange.ts";

/**
 * HTTP implementation of {@link DeleteExchange}.
 *
 * @layer
 * @provides Stackit.RabbitMQ.DeleteExchange
 */
export const DeleteExchangeHttp = Layer.succeed(
  DeleteExchange,
  makeVhostHttpBinding({
    tag: "Stackit.RabbitMQ.DeleteExchange",
    operation: management.deleteExchange,
  }),
);
