import * as alb from "@distilled.cloud/stackit/alb";
import * as Layer from "effect/Layer";
import { makeLoadBalancerHttpBinding } from "./BindingHttp.ts";
import { GetLoadBalancer } from "./GetLoadBalancer.ts";

/**
 * HTTP implementation of {@link GetLoadBalancer}.
 *
 * @layer
 * @provides Stackit.ALB.GetLoadBalancer
 */
export const GetLoadBalancerHttp = Layer.effect(
  GetLoadBalancer,
  makeLoadBalancerHttpBinding({
    tag: "Stackit.ALB.GetLoadBalancer",
    access: { permissions: ["alb.loadbalancer.get"] },
    operation: alb.getLoadBalancer,
  }),
);
