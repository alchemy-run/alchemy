import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListNetworkChecks } from "./ListNetworkChecks.ts";

/**
 * HTTP implementation of {@link ListNetworkChecks}.
 *
 * @layer
 * @provides Stackit.Observability.ListNetworkChecks
 */
export const ListNetworkChecksHttp = Layer.effect(
  ListNetworkChecks,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.ListNetworkChecks",
    access: INSTANCE_READ_ACCESS,
    operation: observability.listNetworkChecks,
  }),
);
