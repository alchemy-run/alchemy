import * as synthetics from "@distilled.cloud/aws/synthetics";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeSyntheticsCanaryHttpBinding } from "./BindingHttp.ts";
import type { Canary } from "./Canary.ts";

/**
 * Runtime binding for `synthetics:StopCanary` — stop future runs of the
 * bound {@link Canary} (an in-flight run completes on its own); the canary
 * name is injected automatically.
 *
 * Provide `Synthetics.StopCanaryHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * ### Controlling the Canary
 * **Example:** Stop the Canary
 * ```typescript
 * // init — grants synthetics:StopCanary on the canary
 * const stopCanary = yield* AWS.Synthetics.StopCanary(canary);
 *
 * // runtime — a ConflictException means it is not currently running
 * yield* stopCanary().pipe(
 *   Effect.catchTag("ConflictException", () => Effect.void),
 * );
 * ```
 *
 * @binding
 */
export interface StopCanary extends Binding.Service<
  StopCanary,
  "AWS.Synthetics.StopCanary",
  (
    canary: Canary,
  ) => Effect.Effect<() => Effect.Effect<synthetics.StopCanaryResponse, synthetics.StopCanaryError>>
> {}

export const StopCanary = Binding.Service<StopCanary>("AWS.Synthetics.StopCanary");

export const StopCanaryHttp = Layer.effect(
  StopCanary,
  makeSyntheticsCanaryHttpBinding({
    tag: "AWS.Synthetics.StopCanary",
    operation: synthetics.stopCanary,
    actions: ["synthetics:StopCanary"],
  }),
);
