import * as rabbitmq from "@distilled.cloud/stackit/rabbitmq";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListBackups } from "./ListBackups.ts";

/**
 * HTTP implementation of {@link ListBackups}.
 *
 * @layer
 * @provides Stackit.RabbitMQ.ListBackups
 */
export const ListBackupsHttp = Layer.effect(
  ListBackups,
  makeInstanceHttpBinding({
    tag: "Stackit.RabbitMQ.ListBackups",
    permission: "rabbitmq.proxy.read",
    operation: rabbitmq.listBackups,
  }),
);
