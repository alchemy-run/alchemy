import * as lb from "@distilled.cloud/stackit/load_balancer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeLoadBalancerHttpBinding } from "./BindingHttp.ts";
import { UpdateTargetPool } from "./UpdateTargetPool.ts";

/**
 * HTTP implementation of {@link UpdateTargetPool}.
 *
 * @layer
 * @provides Stackit.LoadBalancer.UpdateTargetPool
 */
export const UpdateTargetPoolHttp = Layer.effect(
  UpdateTargetPool,
  makeLoadBalancerHttpBinding({
    tag: "Stackit.LoadBalancer.UpdateTargetPool",
    access: { permissions: ["nlb.targetpool.replace"] },
    // The pool's name also goes in the body, as STACKIT's own clients send it.
    operation: Effect.gen(function* () {
      const updateTargetPool = yield* lb.updateTargetPool;
      return (input: lb.UpdateTargetPoolRequest) =>
        updateTargetPool({ ...input, bodyName: input.targetPoolName });
    }),
  }),
);
