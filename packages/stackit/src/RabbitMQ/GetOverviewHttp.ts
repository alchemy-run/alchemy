import * as management from "@distilled.cloud/stackit/rabbitmq_management";
import * as Layer from "effect/Layer";
import { makeBrokerHttpBinding } from "./BindingHttp.ts";
import { GetOverview } from "./GetOverview.ts";

/**
 * HTTP implementation of {@link GetOverview}.
 *
 * @layer
 * @provides Stackit.RabbitMQ.GetOverview
 */
export const GetOverviewHttp = Layer.succeed(
  GetOverview,
  makeBrokerHttpBinding({
    tag: "Stackit.RabbitMQ.GetOverview",
    operation: management.getOverview,
  }),
);
