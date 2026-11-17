import type * as functions from "@distilled.cloud/modal/functions";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FunctionLookupError } from "./FunctionTarget.ts";
import type { OpError } from "./internal.ts";
import type { FunctionTarget } from "./InvokeFunction.ts";
import type { ReadFunctionOps } from "./ReadFunctionHttp.ts";
import type { Server } from "./Server.ts";

/** A time range: `Date`s, ISO strings, or epoch milliseconds. */
export interface TimeRange {
  readonly since: Date | string | number;
  readonly until?: Date | string | number;
}

/** Observe a function: load, call counts and metrics. */
export interface FunctionReader {
  /** Inputs waiting and running, and the containers serving them, right now. */
  stats(): Effect.Effect<
    {
      readonly backlog: number;
      readonly runningInputs: number;
      readonly containers: number;
      readonly inputHeadroom: number;
    },
    FunctionLookupError | OpError<ReadFunctionOps, "currentStats">,
    RuntimeContext
  >;
  /** Input outcomes, latency percentiles and container counts over a time range. */
  timeRangeStats(
    range: TimeRange & { readonly containerId?: string },
  ): Effect.Effect<
    functions.FunctionGetTimeRangeStatsResponse,
    FunctionLookupError | OpError<ReadFunctionOps, "timeRangeStats">,
    RuntimeContext
  >;
  /** Metric series (`containers`, `calls`) over a time range. */
  metrics(
    range: TimeRange & {
      /** Seconds per bucket. @default 3600 */
      readonly bucketSecs?: number;
      readonly groups?: ReadonlyArray<string>;
    },
  ): Effect.Effect<
    functions.FunctionGetMetricsResponse,
    FunctionLookupError | OpError<ReadFunctionOps, "metrics">,
    RuntimeContext
  >;
  /** Calls started per time bucket. */
  callCount(
    range: TimeRange & {
      /** Seconds per bucket. @default 3600 */
      readonly bucketSecs?: number;
    },
  ): Effect.Effect<
    functions.FunctionCallCountResponse,
    FunctionLookupError | OpError<ReadFunctionOps, "callCount">,
    RuntimeContext
  >;
  /** The inputs of one call, by outcome. */
  callInfo(call: {
    readonly functionCallId: string;
  }): Effect.Effect<
    functions.FunctionCallGetInfoResponse,
    FunctionLookupError | OpError<ReadFunctionOps, "callInfo">,
    RuntimeContext
  >;
  /** The autoscaler settings in effect. */
  autoscaler(): Effect.Effect<
    functions.AutoscalerSettings | undefined,
    FunctionLookupError | OpError<ReadFunctionOps, "schedulingParams">,
    RuntimeContext
  >;
}

/**
 * Read a Modal Function's (or Server's) live state from any runtime:
 * backlog and running inputs, call counts, outcome counts, latency
 * percentiles and metric series. Bind a resource of the Stack, or a function
 * deployed with `modal deploy` by name.
 *
 * ### Watch the backlog
 * **Example:** Shed load when the queue is long
 * ```typescript
 * const embed = yield* Modal.ReadFunction(Embed);
 * const { backlog } = yield* embed.stats();
 * if (backlog > 100) return HttpServerResponse.text("busy", { status: 503 });
 * ```
 *
 * ### History
 * **Example:** Failures in the last hour
 * ```typescript
 * const stats = yield* embed.timeRangeStats({ since: new Date(Date.now() - 3_600_000) });
 * yield* Effect.log(`${stats.inputFailureCount} failed of ${stats.inputSuccessCount}`);
 * ```
 *
 * @binding
 * @product Function
 */
export interface ReadFunction extends Binding.Service<
  ReadFunction,
  "Modal.ReadFunction",
  (target: FunctionTarget | Server) => Effect.Effect<FunctionReader>
> {}

export const ReadFunction = Binding.Service<ReadFunction>("Modal.ReadFunction");
