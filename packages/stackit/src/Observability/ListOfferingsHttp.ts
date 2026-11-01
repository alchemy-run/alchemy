import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { PLAN_LIST_ACCESS, makeProjectHttpBinding } from "./BindingHttp.ts";
import { ListOfferings } from "./ListOfferings.ts";

/**
 * HTTP implementation of {@link ListOfferings}.
 *
 * @layer
 * @provides Stackit.Observability.ListOfferings
 */
export const ListOfferingsHttp = Layer.effect(
  ListOfferings,
  makeProjectHttpBinding({
    tag: "Stackit.Observability.ListOfferings",
    access: PLAN_LIST_ACCESS,
    operation: observability.listOfferings,
  }),
);
