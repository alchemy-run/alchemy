import * as alb from "@distilled.cloud/stackit/alb";
import * as Layer from "effect/Layer";
import { makeScopeHttpBinding } from "../LoadBalancer/BindingHttp.ts";
import { ListLoadBalancers } from "./ListLoadBalancers.ts";

/**
 * HTTP implementation of {@link ListLoadBalancers}.
 *
 * @layer
 * @provides Stackit.ALB.ListLoadBalancers
 */
export const ListLoadBalancersHttp = Layer.effect(
  ListLoadBalancers,
  makeScopeHttpBinding({
    tag: "Stackit.ALB.ListLoadBalancers",
    access: { permissions: ["alb.loadbalancer.list"] },
    operation: alb.listLoadBalancers,
  }),
);
