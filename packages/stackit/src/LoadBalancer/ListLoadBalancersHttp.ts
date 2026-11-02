import * as lb from "@distilled.cloud/stackit/load_balancer";
import * as Layer from "effect/Layer";
import { makeScopeHttpBinding } from "./BindingHttp.ts";
import { ListLoadBalancers } from "./ListLoadBalancers.ts";

/**
 * HTTP implementation of {@link ListLoadBalancers}.
 *
 * @layer
 * @provides Stackit.LoadBalancer.ListLoadBalancers
 */
export const ListLoadBalancersHttp = Layer.effect(
  ListLoadBalancers,
  makeScopeHttpBinding({
    tag: "Stackit.LoadBalancer.ListLoadBalancers",
    access: { permissions: ["nlb.loadbalancer.list"] },
    operation: lb.listLoadBalancers,
  }),
);
