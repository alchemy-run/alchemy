import type * as server from "@distilled.cloud/modal/server";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FunctionLookupError } from "./FunctionTarget.ts";
import type { OpError } from "./internal.ts";
import type { TimeRange } from "./ReadFunction.ts";
import type { ReadServerOps } from "./ReadServerHttp.ts";
import type { Server } from "./Server.ts";

/** One request a Server handled. */
export interface ServerRequest {
  readonly route: string | undefined;
  readonly timestamp: string | undefined;
  readonly containerId: string | undefined;
  readonly durationSeconds: number | undefined;
  readonly status: number | undefined;
}

/** A container serving a Server's requests. */
export interface ServerContainer {
  readonly containerId: string;
  readonly host: string | undefined;
  readonly port: number | undefined;
}

/** Observe a Server: requests, status codes, latency and containers. */
export interface ServerReader {
  /** Request counts by status code, latency percentiles and inference stats over a time range. */
  stats(
    range: TimeRange & { readonly containerId?: string },
  ): Effect.Effect<
    server.ServerGetTimeRangeStatsResponse,
    FunctionLookupError | OpError<ReadServerOps, "stats">,
    RuntimeContext
  >;
  /**
   * Requests the Server handled: the most recent `limit` (newest first, last
   * seven days), or those in a time range (oldest first).
   */
  requests(
    query: { readonly limit: number } | TimeRange,
  ): Effect.Effect<
    ReadonlyArray<ServerRequest>,
    FunctionLookupError | OpError<ReadServerOps, "requests">,
    RuntimeContext
  >;
  /** Requests per time bucket. */
  requestCount(
    range: TimeRange & { readonly bucketSecs?: number },
  ): Effect.Effect<
    server.ServerCountRequestsResponse,
    FunctionLookupError | OpError<ReadServerOps, "requestCount">,
    RuntimeContext
  >;
  /** Metric series (`containers`, `requests`) over a time range. */
  metrics(
    range: TimeRange & { readonly bucketSecs?: number; readonly groups?: ReadonlyArray<string> },
  ): Effect.Effect<
    server.ServerGetMetricsResponse,
    FunctionLookupError | OpError<ReadServerOps, "metrics">,
    RuntimeContext
  >;
  /** Containers registered to serve requests right now. */
  containers(): Effect.Effect<
    ReadonlyArray<ServerContainer>,
    FunctionLookupError | OpError<ReadServerOps, "containers">,
    RuntimeContext
  >;
}

/**
 * Read a `Modal.Server`'s traffic from any runtime: request log, status
 * codes, latency percentiles, metric series and live containers.
 *
 * ### Error rate
 * **Example:** 5xx responses in the last ten minutes
 * ```typescript
 * const api = yield* Modal.ReadServer(Api);
 * const stats = yield* api.stats({ since: new Date(Date.now() - 600_000) });
 * ```
 *
 * ### Recent requests
 * **Example:** The last 20 requests
 * ```typescript
 * const recent = yield* api.requests({ limit: 20 });
 * ```
 *
 * @binding
 * @product Server
 */
export interface ReadServer extends Binding.Service<
  ReadServer,
  "Modal.ReadServer",
  (server: Server) => Effect.Effect<ServerReader>
> {}

export const ReadServer = Binding.Service<ReadServer>("Modal.ReadServer");
