import * as management from "@distilled.cloud/stackit/rabbitmq_management";
import * as Layer from "effect/Layer";
import { makeVhostHttpBinding } from "./BindingHttp.ts";
import { DeclareExchange } from "./DeclareExchange.ts";

/**
 * HTTP implementation of {@link DeclareExchange}.
 *
 * @layer
 * @provides Stackit.RabbitMQ.DeclareExchange
 */
export const DeclareExchangeHttp = Layer.succeed(
  DeclareExchange,
  makeVhostHttpBinding({
    tag: "Stackit.RabbitMQ.DeclareExchange",
    operation: management.putExchange,
  }),
);
