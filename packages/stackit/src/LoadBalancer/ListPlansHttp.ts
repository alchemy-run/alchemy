import * as lb from "@distilled.cloud/stackit/load_balancer";
import * as Layer from "effect/Layer";
import { makeUnscopedHttpBinding } from "./BindingHttp.ts";
import { ListPlans } from "./ListPlans.ts";

/**
 * HTTP implementation of {@link ListPlans}.
 *
 * @layer
 * @provides Stackit.LoadBalancer.ListPlans
 */
export const ListPlansHttp = Layer.effect(
  ListPlans,
  makeUnscopedHttpBinding({
    tag: "Stackit.LoadBalancer.ListPlans",
    operation: lb.listPlans,
  }),
);
