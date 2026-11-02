import * as rabbitmq from "@distilled.cloud/stackit/rabbitmq";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListCredentials } from "./ListCredentials.ts";

/**
 * HTTP implementation of {@link ListCredentials}.
 *
 * @layer
 * @provides Stackit.RabbitMQ.ListCredentials
 */
export const ListCredentialsHttp = Layer.effect(
  ListCredentials,
  makeInstanceHttpBinding({
    tag: "Stackit.RabbitMQ.ListCredentials",
    permission: "rabbitmq.credential.list",
    operation: rabbitmq.listCredentials,
  }),
);
