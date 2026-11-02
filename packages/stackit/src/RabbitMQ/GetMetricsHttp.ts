import * as rabbitmq from "@distilled.cloud/stackit/rabbitmq";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetMetrics } from "./GetMetrics.ts";

/**
 * HTTP implementation of {@link GetMetrics}.
 *
 * @layer
 * @provides Stackit.RabbitMQ.GetMetrics
 */
export const GetMetricsHttp = Layer.effect(
  GetMetrics,
  makeInstanceHttpBinding({
    tag: "Stackit.RabbitMQ.GetMetrics",
    permission: "rabbitmq.proxy.read",
    operation: rabbitmq.getMetrics,
  }),
);
