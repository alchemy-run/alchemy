import * as rabbitmq from "@distilled.cloud/stackit/rabbitmq";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListRestores } from "./ListRestores.ts";

/**
 * HTTP implementation of {@link ListRestores}.
 *
 * @layer
 * @provides Stackit.RabbitMQ.ListRestores
 */
export const ListRestoresHttp = Layer.effect(
  ListRestores,
  makeInstanceHttpBinding({
    tag: "Stackit.RabbitMQ.ListRestores",
    permission: "rabbitmq.proxy.read",
    operation: rabbitmq.listRestores,
  }),
);
