/**
 * Axiom's flavour of the OpenTelemetry Collector Lambda extension: the
 * pinned managed extension layer, a Collector configuration that ships with
 * alchemy, and the ingest credential wiring — in one call.
 *
 * @packageDocumentation
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  Collector,
  type CollectorExtension,
  type CollectorExtensionArn,
} from "../AWS/Lambda/Collector.ts";
import { LayerVersion } from "../AWS/Lambda/LayerVersion.ts";
import type { Input } from "../Input.ts";
import type { ApiToken } from "./ApiToken.ts";
import type { Dataset } from "./Dataset.ts";
import type { ResourceInput } from "./Telemetry.ts";

/**
 * The Collector configuration this preset ships.
 *
 * Declared inline rather than as a data file: the layer is packaged through
 * `LayerVersion.content`, so it survives bundling and needs no asset path
 * resolution in consumer projects.
 *
 * Shape notes, all of which the pipelines depend on:
 * - The `otlp` receiver binds loopback only — the extension is reachable
 *   from the handler and from nothing else.
 * - `memory_limiter` runs FIRST so a backpressured backend sheds load
 *   instead of pushing the sandbox into an OOM kill.
 * - `decouple` runs LAST, which is what moves remote export off the
 *   response path and onto the extension's own lifecycle.
 * - Traces and logs get separate exporters because Axiom routes by dataset
 *   header, and the two signals belong in differently-shaped datasets.
 */
const COLLECTOR_YAML = `receivers:
  otlp:
    protocols:
      http:
        endpoint: 127.0.0.1:4318

processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 128
    spike_limit_mib: 32
  batch:
    timeout: 1s
  decouple:
    # Once full, this in-memory queue applies backpressure to the function's
    # local export. It improves latency; it does not make delivery durable.
    max_queue_size: 200

exporters:
  otlphttp/axiom-traces:
    compression: zstd
    endpoint: \${env:AXIOM_OTLP_ENDPOINT}
    headers:
      authorization: Bearer \${env:AXIOM_INGEST_TOKEN}
      x-axiom-dataset: \${env:AXIOM_TRACES_DATASET}
  otlphttp/axiom-logs:
    compression: zstd
    endpoint: \${env:AXIOM_OTLP_ENDPOINT}
    headers:
      authorization: Bearer \${env:AXIOM_INGEST_TOKEN}
      x-axiom-dataset: \${env:AXIOM_LOGS_DATASET}

service:
  telemetry:
    logs:
      level: warn
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch, decouple]
      exporters: [otlphttp/axiom-traces]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, batch, decouple]
      exporters: [otlphttp/axiom-logs]
`;

/** Axiom's OTLP/HTTP ingest host. */
const DEFAULT_OTLP_ENDPOINT = "https://api.axiom.co";

export interface AxiomLambdaCollectorProps {
  /**
   * The ingest credential. Must have `ingest: ["create"]` capability on
   * every dataset passed below.
   */
  token: ResourceInput<ApiToken>;
  /** Dataset (kind `otel:traces:v1`) traces are exported into. */
  traces: ResourceInput<Dataset>;
  /** Dataset (kind `otel:logs:v1`) logs are exported into. */
  logs: ResourceInput<Dataset>;
  /**
   * Axiom's OTLP/HTTP host.
   * @default "https://api.axiom.co"
   */
  endpoint?: Input<string>;
  /**
   * The logical id of the generated configuration `LayerVersion`. Give two
   * Functions the same id inside one stack and they share one layer.
   * @default "AxiomCollectorConfig"
   */
  configId?: string;
  /** Managed extension layer pinning — see `AWS.Lambda.Collector`. */
  extension?: CollectorExtension | CollectorExtensionArn;
  /**
   * Attach nothing and export nothing. Defaults to `true` during
   * `alchemy dev` — see `AWS.Lambda.Collector`.
   */
  disabled?: boolean;
  /**
   * The exported `service.name`.
   * @default the deployed Function's physical name
   */
  serviceName?: Input<string>;
}

/**
 * Resource declarations are Effects — yield them to get the instance with
 * attribute Output accessors, same as `Axiom.Telemetry` does.
 */
const instance = <T>(resource: ResourceInput<T>): Effect.Effect<T> =>
  Effect.isEffect(resource)
    ? (resource as Effect.Effect<T>)
    : Effect.succeed(resource);

/**
 * Export a Lambda's telemetry to Axiom through the OpenTelemetry Collector
 * extension.
 *
 * The Lambda counterpart to {@link import("./Telemetry.ts").Telemetry |
 * Axiom.Telemetry}. `Axiom.Telemetry` exports from inside the handler,
 * which puts Axiom's latency in front of the response; this preset hands
 * export to the Collector extension, which drains after the response has
 * already gone out. Delivery becomes best-effort in exchange — a reclaimed
 * environment can drop what is still queued.
 *
 * @section Exporting to Axiom
 * @example One call
 * ```typescript
 * const Traces = Axiom.Dataset("traces", { name: "api-traces", kind: "otel:traces:v1" });
 * const Logs = Axiom.Dataset("logs", { name: "api-logs", kind: "otel:logs:v1" });
 * const Ingest = Axiom.ApiToken("ingest", {
 *   name: "api-ingest",
 *   datasetCapabilities: {
 *     "api-traces": { ingest: ["create"] },
 *     "api-logs": { ingest: ["create"] },
 *   },
 * });
 *
 * export default class Api extends AWS.Lambda.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url, architecture: "arm64" },
 *   Effect.gen(function* () {
 *     return { fetch: handler };
 *   }).pipe(
 *     Effect.provide(
 *       Axiom.LambdaCollector({ token: Ingest, traces: Traces, logs: Logs }),
 *     ),
 *   ),
 * ) {}
 * ```
 *
 * @section Customizing
 * @example Share one config layer across Functions
 * ```typescript
 * // Same `configId` inside one stack resolves to one LayerVersion.
 * Axiom.LambdaCollector({
 *   token: Ingest,
 *   traces: Traces,
 *   logs: Logs,
 *   configId: "SharedAxiomCollectorConfig",
 * })
 * ```
 *
 * @example A self-hosted Axiom endpoint
 * ```typescript
 * Axiom.LambdaCollector({
 *   token: Ingest,
 *   traces: Traces,
 *   logs: Logs,
 *   endpoint: "https://axiom.internal.example.com",
 * })
 * ```
 *
 * @example Take over the Collector configuration
 * ```typescript
 * // Beyond what this preset exposes, drop to the primitive and bring your
 * // own collector.yaml.
 * AWS.Lambda.Collector({
 *   config: fileURLToPath(new URL("./collector-config", import.meta.url)),
 *   env: { AXIOM_INGEST_TOKEN: token.token, AXIOM_TRACES_DATASET: traces.name },
 * })
 * ```
 */
export const LambdaCollector = (
  props: AxiomLambdaCollectorProps,
): Layer.Layer<never> =>
  Layer.unwrap(
    Effect.gen(function* () {
      // Declarations are yielded to instances (registering them on the Stack
      // if this host is the first to reference them) so the accessors below
      // produce real Outputs.
      const token = yield* instance(props.token);
      const traces = yield* instance(props.traces);
      const logs = yield* instance(props.logs);
      return Collector({
        config: LayerVersion(props.configId ?? "AxiomCollectorConfig", {
          content: { "collector.yaml": COLLECTOR_YAML },
          description: "Axiom OpenTelemetry Collector configuration",
        }),
        extension: props.extension,
        disabled: props.disabled,
        serviceName: props.serviceName,
        env: {
          AXIOM_OTLP_ENDPOINT: props.endpoint ?? DEFAULT_OTLP_ENDPOINT,
          // The token binds as a secret: `ApiToken.token` is `Redacted`, and
          // the binding channel routes Redacted values away from plaintext
          // state. `Bearer ` is prepended in the collector config rather than
          // here so the redaction survives interpolation.
          AXIOM_INGEST_TOKEN: token.token,
          AXIOM_TRACES_DATASET: traces.name,
          AXIOM_LOGS_DATASET: logs.name,
        },
      });
    }),
  ) as Layer.Layer<never>;

/** The Collector configuration this preset packages. Exported for tests. */
export const axiomCollectorYaml = COLLECTOR_YAML;
