import * as rabbitmq from "@distilled.cloud/stackit/rabbitmq";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetInstance } from "./GetInstance.ts";

/**
 * HTTP implementation of {@link GetInstance}.
 *
 * @layer
 * @provides Stackit.RabbitMQ.GetInstance
 */
export const GetInstanceHttp = Layer.effect(
  GetInstance,
  makeInstanceHttpBinding({
    tag: "Stackit.RabbitMQ.GetInstance",
    permission: "rabbitmq.instance.get",
    operation: rabbitmq.getInstance,
  }),
);
