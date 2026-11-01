import * as mongodb from "@distilled.cloud/stackit/mongodb_flex";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListMetrics } from "./ListMetrics.ts";

/**
 * HTTP implementation of {@link ListMetrics}.
 *
 * @layer
 * @provides Stackit.MongoDBFlex.ListMetrics
 */
export const ListMetricsHttp = Layer.effect(
  ListMetrics,
  makeInstanceHttpBinding({
    tag: "Stackit.MongoDBFlex.ListMetrics",
    access: { permissions: ["mongodb-flex.metric.get"] },
    operation: mongodb.listMetrics,
  }),
);
