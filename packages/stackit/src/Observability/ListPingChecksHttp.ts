import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListPingChecks } from "./ListPingChecks.ts";

/**
 * HTTP implementation of {@link ListPingChecks}.
 *
 * @layer
 * @provides Stackit.Observability.ListPingChecks
 */
export const ListPingChecksHttp = Layer.effect(
  ListPingChecks,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.ListPingChecks",
    access: INSTANCE_READ_ACCESS,
    operation: observability.listPingChecks,
  }),
);
