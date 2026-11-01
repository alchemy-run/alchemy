import * as ske from "@distilled.cloud/stackit/ske";
import * as Layer from "effect/Layer";
import { makeClusterHttpBinding, SKE_ACCESS } from "./BindingHttp.ts";
import { TriggerWakeup } from "./TriggerWakeup.ts";

/**
 * HTTP implementation of {@link TriggerWakeup}.
 *
 * @layer
 * @provides Stackit.SKE.TriggerWakeup
 */
export const TriggerWakeupHttp = Layer.effect(
  TriggerWakeup,
  makeClusterHttpBinding({
    tag: "Stackit.SKE.TriggerWakeup",
    access: SKE_ACCESS.wakeup,
    operation: ske.triggerWakeup,
  }),
);
