import type * as Credentials from "@distilled.cloud/aws/Credentials";
import type * as SigV4 from "@distilled.cloud/aws/SigV4";
import * as Binding from "alchemy/Binding";
import * as Clock from "effect/Clock";
import type { SourceError } from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAmpWorkspaceHttpBinding } from "./BindingHttp.ts";
import type { PrometheusApiError } from "./PrometheusTypes.ts";
import { encodeWriteRequest, snappyCompress, type EncodableSeries } from "./RemoteWriteCodec.ts";
import type { Workspace } from "./Workspace.ts";

export interface RemoteWriteSample {
  /** Sample value. */
  value: number;
  /**
   * Sample timestamp in epoch **milliseconds**.
   * @default the time of the remote-write call
   */
  timestamp?: number;
}

export interface RemoteWriteSeries {
  /** Metric name (becomes the `__name__` label). */
  name: string;
  /** Additional labels for the series. */
  labels?: Record<string, string>;
  /** Samples to append, oldest first. */
  samples: RemoteWriteSample[];
}

export interface RemoteWriteRequest {
  /** Time series to write. */
  timeseries: RemoteWriteSeries[];
}

/**
 * Runtime binding for `aps:RemoteWrite` — push metric samples into an AMP
 * {@link Workspace} via its Prometheus remote-write endpoint
 * (`api/v1/remote_write`), SigV4-signed with the host Function's credentials.
 *
 * The protobuf + snappy remote-write body is encoded internally — callers
 * pass plain metric names, labels, and samples.
 *
 * ### Writing Metrics
 * **Example:** Push a Counter Sample
 * ```typescript
 * const remoteWrite = yield* AMP.RemoteWrite(workspace);
 *
 * yield* remoteWrite({
 *   timeseries: [{
 *     name: "jobs_processed_total",
 *     labels: { queue: "default" },
 *     samples: [{ value: 42 }],
 *   }],
 * });
 * ```
 *
 * **Example:** Backfill Samples with Explicit Timestamps
 * ```typescript
 * yield* remoteWrite({
 *   timeseries: [{
 *     name: "temperature_celsius",
 *     labels: { sensor: "a1" },
 *     samples: [
 *       { value: 20.1, timestamp: Date.now() - 60_000 },
 *       { value: 20.4, timestamp: Date.now() },
 *     ],
 *   }],
 * });
 * ```
 *
 * @binding
 */
export interface RemoteWrite extends Binding.Service<
  RemoteWrite,
  "AWS.AMP.RemoteWrite",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: RemoteWriteRequest,
    ) => Effect.Effect<
      void,
      PrometheusApiError | Credentials.CredentialsError | SourceError | SigV4.SigningError
    >
  >
> {}
export const RemoteWrite = Binding.Service<RemoteWrite>("AWS.AMP.RemoteWrite");

export const RemoteWriteHttp = Layer.effect(
  RemoteWrite,
  makeAmpWorkspaceHttpBinding({
    name: "RemoteWrite",
    iamActions: ["aps:RemoteWrite"],
    makeClient: (send) => (request: RemoteWriteRequest) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const body = yield* Effect.sync(() => {
          const timeseries: EncodableSeries[] = request.timeseries.map((series) => ({
            labels: { ...series.labels, __name__: series.name },
            samples: series.samples.map((sample) => ({
              value: sample.value,
              timestamp: sample.timestamp ?? now,
            })),
          }));
          return snappyCompress(encodeWriteRequest(timeseries));
        });
        yield* send({
          method: "POST",
          path: "api/v1/remote_write",
          bytes: {
            data: body,
            contentType: "application/x-protobuf",
            headers: {
              "content-encoding": "snappy",
              "x-prometheus-remote-write-version": "0.1.0",
            },
          },
        });
      }),
  }),
);
