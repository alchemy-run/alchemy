import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListRabbitMQChecks } from "./ListRabbitMQChecks.ts";

/**
 * HTTP implementation of {@link ListRabbitMQChecks}.
 *
 * @layer
 * @provides Stackit.Observability.ListRabbitMQChecks
 */
export const ListRabbitMQChecksHttp = Layer.effect(
  ListRabbitMQChecks,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.ListRabbitMQChecks",
    access: INSTANCE_READ_ACCESS,
    operation: observability.listRabbitmqChecks,
  }),
);
