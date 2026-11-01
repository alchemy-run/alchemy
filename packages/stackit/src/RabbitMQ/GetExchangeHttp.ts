import * as management from "@distilled.cloud/stackit/rabbitmq_management";
import * as Layer from "effect/Layer";
import { makeVhostHttpBinding } from "./BindingHttp.ts";
import { GetExchange } from "./GetExchange.ts";

/**
 * HTTP implementation of {@link GetExchange}.
 *
 * @layer
 * @provides Stackit.RabbitMQ.GetExchange
 */
export const GetExchangeHttp = Layer.succeed(
  GetExchange,
  makeVhostHttpBinding({
    tag: "Stackit.RabbitMQ.GetExchange",
    operation: management.getExchange,
  }),
);
