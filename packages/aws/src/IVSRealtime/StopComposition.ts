import * as ivsrealtime from "@distilled.cloud/aws/ivs-realtime";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { COMPOSITION_ARN_WILDCARD, makeIvsRealtimeAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Stop and delete a composition — any broadcast to the composition's
 * destinations ends. Compositions are addressed by the server-generated
 * ARN returned by `StartComposition`.
 *
 * ### Compositing a Stage
 * **Example:** Stop a running composition
 * ```typescript
 * // init
 * const stopComposition = yield* IVSRealtime.StopComposition();
 *
 * // runtime
 * yield* stopComposition({ arn: compositionArn });
 * ```
 *
 * @binding
 */
export interface StopComposition extends Binding.Service<
  StopComposition,
  "AWS.IVSRealtime.StopComposition",
  () => Effect.Effect<
    (
      request: ivsrealtime.StopCompositionRequest,
    ) => Effect.Effect<ivsrealtime.StopCompositionResponse, ivsrealtime.StopCompositionError>
  >
> {}
export const StopComposition = Binding.Service<StopComposition>("AWS.IVSRealtime.StopComposition");

export const StopCompositionHttp = Layer.effect(
  StopComposition,
  makeIvsRealtimeAccountHttpBinding({
    tag: "AWS.IVSRealtime.StopComposition",
    operation: ivsrealtime.stopComposition,
    actions: ["ivs:StopComposition"],
    resources: [COMPOSITION_ARN_WILDCARD],
  }),
);
