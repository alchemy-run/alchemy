import * as management from "@distilled.cloud/stackit/rabbitmq_management";
import * as Layer from "effect/Layer";
import { makeVhostHttpBinding } from "./BindingHttp.ts";
import { ListExchanges } from "./ListExchanges.ts";

/**
 * HTTP implementation of {@link ListExchanges}.
 *
 * @layer
 * @provides Stackit.RabbitMQ.ListExchanges
 */
export const ListExchangesHttp = Layer.succeed(
  ListExchanges,
  makeVhostHttpBinding({
    tag: "Stackit.RabbitMQ.ListExchanges",
    operation: management.listExchanges,
  }),
);
