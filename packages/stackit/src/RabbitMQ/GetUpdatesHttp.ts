import * as rabbitmq from "@distilled.cloud/stackit/rabbitmq";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetUpdates } from "./GetUpdates.ts";

/**
 * HTTP implementation of {@link GetUpdates}.
 *
 * @layer
 * @provides Stackit.RabbitMQ.GetUpdates
 */
export const GetUpdatesHttp = Layer.effect(
  GetUpdates,
  makeInstanceHttpBinding({
    tag: "Stackit.RabbitMQ.GetUpdates",
    permission: "rabbitmq.proxy.read",
    operation: rabbitmq.getUpdates,
  }),
);
