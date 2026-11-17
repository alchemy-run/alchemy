import type * as functions from "@distilled.cloud/modal/functions";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FunctionLookupError } from "./FunctionTarget.ts";
import type { OpError } from "./internal.ts";
import type { FunctionTarget } from "./InvokeFunction.ts";
import type { ScaleFunctionOps } from "./ScaleFunctionHttp.ts";
import type { Server } from "./Server.ts";

/** Autoscaler settings to override; unset fields keep their value. */
export interface AutoscalerOverride {
  /** Containers kept running regardless of demand. */
  readonly minContainers?: number;
  /** Most containers running at once. */
  readonly maxContainers?: number;
  /** Idle containers kept on top of demand while busy. */
  readonly bufferContainers?: number;
  /** Seconds of sustained demand before scaling up. */
  readonly scaleupWindow?: number;
  /** Seconds a container may stay idle before it scales down. */
  readonly scaledownWindow?: number;
  /** A Server's target concurrent requests per container (fractional allowed). */
  readonly targetConcurrency?: number;
}

/** Change a function's autoscaler at runtime. */
export interface FunctionScaler {
  /** The settings in effect. */
  autoscaler(): Effect.Effect<
    functions.AutoscalerSettings | undefined,
    FunctionLookupError | OpError<ScaleFunctionOps, "schedulingParams">,
    RuntimeContext
  >;
  /**
   * Override settings until the next deploy, which restores the declared
   * ones. Returns the settings now in effect.
   */
  update(
    settings: AutoscalerOverride,
  ): Effect.Effect<
    functions.AutoscalerSettings | undefined,
    FunctionLookupError | OpError<ScaleFunctionOps, "schedulingParams" | "updateSchedulingParams">,
    RuntimeContext
  >;
}

/**
 * Scale a Modal Function or Server from a running program: keep containers
 * warm ahead of a launch, or cap them at night. Overrides last until the
 * next deploy; use the resource's own props (or `Modal.FunctionAutoscaler`
 * for a function deployed outside the Stack) for the steady state.
 *
 * ### Warm up ahead of traffic
 * **Example:** From a scheduled Worker
 * ```typescript
 * const generate = yield* Modal.ScaleFunction(Generate);
 * yield* generate.update({ minContainers: 4, bufferContainers: 2 });
 * ```
 *
 * @binding
 * @product Function
 */
export interface ScaleFunction extends Binding.Service<
  ScaleFunction,
  "Modal.ScaleFunction",
  (target: FunctionTarget | Server) => Effect.Effect<FunctionScaler>
> {}

export const ScaleFunction = Binding.Service<ScaleFunction>("Modal.ScaleFunction");
