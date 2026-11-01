import * as ske from "@distilled.cloud/stackit/ske";
import * as Layer from "effect/Layer";
import { makeClusterHttpBinding, SKE_ACCESS } from "./BindingHttp.ts";
import { TriggerReconcile } from "./TriggerReconcile.ts";

/**
 * HTTP implementation of {@link TriggerReconcile}.
 *
 * @layer
 * @provides Stackit.SKE.TriggerReconcile
 */
export const TriggerReconcileHttp = Layer.effect(
  TriggerReconcile,
  makeClusterHttpBinding({
    tag: "Stackit.SKE.TriggerReconcile",
    access: SKE_ACCESS.reconcile,
    operation: ske.triggerReconcile,
  }),
);
