import * as mariadb from "@distilled.cloud/stackit/mariadb";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetMetrics } from "./GetMetrics.ts";

/**
 * HTTP implementation of {@link GetMetrics}.
 *
 * @layer
 * @provides Stackit.MariaDB.GetMetrics
 */
export const GetMetricsHttp = Layer.effect(
  GetMetrics,
  makeInstanceHttpBinding({
    tag: "Stackit.MariaDB.GetMetrics",
    permission: "mariadb.proxy.read",
    operation: mariadb.getMetrics,
  }),
);
