import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { PLAN_LIST_ACCESS, makeProjectHttpBinding } from "./BindingHttp.ts";
import { ListPlans } from "./ListPlans.ts";

/**
 * HTTP implementation of {@link ListPlans}.
 *
 * @layer
 * @provides Stackit.Observability.ListPlans
 */
export const ListPlansHttp = Layer.effect(
  ListPlans,
  makeProjectHttpBinding({
    tag: "Stackit.Observability.ListPlans",
    access: PLAN_LIST_ACCESS,
    operation: observability.listPlans,
  }),
);
