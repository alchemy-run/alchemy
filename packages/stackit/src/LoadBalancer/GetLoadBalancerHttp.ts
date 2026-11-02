import * as lb from "@distilled.cloud/stackit/load_balancer";
import * as Layer from "effect/Layer";
import { makeLoadBalancerHttpBinding } from "./BindingHttp.ts";
import { GetLoadBalancer } from "./GetLoadBalancer.ts";

/**
 * HTTP implementation of {@link GetLoadBalancer}.
 *
 * @layer
 * @provides Stackit.LoadBalancer.GetLoadBalancer
 */
export const GetLoadBalancerHttp = Layer.effect(
  GetLoadBalancer,
  makeLoadBalancerHttpBinding({
    tag: "Stackit.LoadBalancer.GetLoadBalancer",
    access: { permissions: ["nlb.loadbalancer.get"] },
    operation: lb.getLoadBalancer,
  }),
);
