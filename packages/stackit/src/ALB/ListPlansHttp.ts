import * as alb from "@distilled.cloud/stackit/alb";
import * as Layer from "effect/Layer";
import { makeUnscopedHttpBinding } from "../LoadBalancer/BindingHttp.ts";
import { ListPlans } from "./ListPlans.ts";

/**
 * HTTP implementation of {@link ListPlans}.
 *
 * @layer
 * @provides Stackit.ALB.ListPlans
 */
export const ListPlansHttp = Layer.effect(
  ListPlans,
  makeUnscopedHttpBinding({
    tag: "Stackit.ALB.ListPlans",
    operation: alb.listPlans,
  }),
);
