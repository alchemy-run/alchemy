import * as alb from "@distilled.cloud/stackit/alb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeLoadBalancerHttpBinding } from "./BindingHttp.ts";
import { UpdateTargetPool } from "./UpdateTargetPool.ts";

/**
 * HTTP implementation of {@link UpdateTargetPool}.
 *
 * @layer
 * @provides Stackit.ALB.UpdateTargetPool
 */
export const UpdateTargetPoolHttp = Layer.effect(
  UpdateTargetPool,
  makeLoadBalancerHttpBinding({
    tag: "Stackit.ALB.UpdateTargetPool",
    access: { permissions: ["alb.targetpool.replace"] },
    // The pool's name also goes in the body, as the spec declares it.
    operation: Effect.gen(function* () {
      const updateTargetPool = yield* alb.updateTargetPool;
      return (input: alb.UpdateTargetPoolRequest) =>
        updateTargetPool({ ...input, bodyName: input.targetPoolName });
    }),
  }),
);
