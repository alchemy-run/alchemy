/**
 * Axiom's flavour of the OpenTelemetry Collector Lambda extension: the
 * pinned managed extension layer, a Collector configuration that ships with
 * alchemy, and the ingest credential wiring — in one call.
 *
 * @packageDocumentation
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  Collector,
  type CollectorExtension,
  type CollectorExtensionArn,
} from "../AWS/Lambda/Collector.ts";
import {
  collector,
  type CollectorInput,
  type EmittedCollectorConfig,
  Exporter,
  pipeline,
  Processor,
  Receiver,
} from "../AWS/Lambda/CollectorConfig.ts";
import type { Input } from "../Input.ts";
import * as Output from "../Output.ts";
import * as Redacted from "effect/Redacted";
import type { ApiToken } from "./ApiToken.ts";
import type { Dataset } from "./Dataset.ts";
import type { ResourceInput } from "./Telemetry.ts";

/** Axiom's OTLP/HTTP ingest host. */
const DEFAULT_OTLP_ENDPOINT = "https://api.axiom.co";

/**
 * Build the `Authorization` header value from the ingest token.
 *
 * Axiom wants `Bearer <token>`, and the prefix is applied INSIDE the
 * redaction: the mapped value is a `Redacted` again, so it stays on the
 * secret channel from here to the deployed environment variable and never
 * reaches the layer archive. Unwrapping to concatenate happens once, at
 * deploy time, inside the same process that is already handling the token —
 * the same trust boundary that encodes it onto the wire.
 *
 * One `Output` is built and handed to BOTH exporters, so the emitter's
 * reference-identity dedupe binds it to a single environment variable.
 */
const bearerToken = (
  token: Output.Output<Redacted.Redacted<string>>,
): Output.Output<Redacted.Redacted<string>> =>
  Output.map(token, (value) =>
    Redacted.make(`Bearer ${Redacted.value(value)}`),
  );

/**
 * The Collector configuration this preset ships.
 *
 * Assembled from the same combinators a caller would use rather than
 * templated YAML, so every component is validated against the generated
 * codec at the call that declares it, the config sections are derived from
 * what the pipelines reference, and the `endpoint` / dataset values route
 * themselves: a plain string bakes into the layer, an `Output` from an
 * `Axiom.Dataset` resource binds as an environment variable instead.
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
 * - One receiver and one processor VALUE each, shared by both pipelines, so
 *   each is declared once.
 *
 * Exported so tests can assert on what the preset actually deploys.
 */
export const axiomCollectorConfig = (options: {
  /** Axiom's OTLP/HTTP host. */
  endpoint: Input<string>;
  /**
   * The complete `Authorization` header value, i.e. `Bearer <token>`.
   *
   * Pass ONE value for both exporters: the emitter binds a shared reference
   * to a single environment variable. A `Redacted` here never reaches the
   * layer archive — see {@link bearerToken}.
   */
  authorization: CollectorInput;
  /** Dataset traces are written to. */
  tracesDataset: Input<string>;
  /** Dataset logs are written to. */
  logsDataset: Input<string>;
}): EmittedCollectorConfig => {
  const otlp = Receiver.otlp({
    protocols: { http: { endpoint: "127.0.0.1:4318" } },
  });
  const processors = [
    Processor.memoryLimiter({
      checkInterval: Duration.seconds(1),
      limitMib: 128,
      spikeLimitMib: 32,
    }),
    Processor.batch({ timeout: Duration.seconds(1) }),
    Processor.decouple({
      // Once full, this in-memory queue applies backpressure to the
      // function's local export. It improves latency; it does not make
      // delivery durable.
      maxQueueSize: 200,
    }),
  ];
  const axiomExporter = (name: string, dataset: Input<string>) =>
    Exporter.otlpHttp(name, {
      compression: "zstd",
      endpoint: options.endpoint,
      headers: {
        authorization: options.authorization,
        "x-axiom-dataset": dataset,
      },
    });

  return collector({
    telemetry: { logs: { level: "warn" } },
    pipelines: {
      traces: pipeline({
        receivers: [otlp],
        processors,
        exporters: [axiomExporter("axiom-traces", options.tracesDataset)],
      }),
      logs: pipeline({
        receivers: [otlp],
        processors,
        exporters: [axiomExporter("axiom-logs", options.logsDataset)],
      }),
    },
  });
};

export interface AxiomLambdaCollectorProps {
  /**
   * The ingest credential. Must have `ingest: ["create"]` capability on
   * every dataset passed below.
   */
  token: ResourceInput<ApiToken>;
  /**
   * Dataset (kind `otel:traces:v1`) traces are exported into — an
   * `Axiom.Dataset` resource, or the name of one that already exists.
   */
  traces: ResourceInput<Dataset> | string;
  /**
   * Dataset (kind `otel:logs:v1`) logs are exported into — an
   * `Axiom.Dataset` resource, or the name of one that already exists.
   */
  logs: ResourceInput<Dataset> | string;
  /**
   * Axiom's OTLP/HTTP host.
   * @default "https://api.axiom.co"
   */
  endpoint?: Input<string>;
  /**
   * The logical id of the generated configuration `LayerVersion`. Give two
   * Functions the same id inside one stack and they share one layer.
   * @default a per-Function id — see `AWS.Lambda.Collector`
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
 * The dataset's ingest name. A declaration is yielded (registering the
 * Dataset), a plain name is taken as-is so an account's pre-existing
 * datasets need no resource.
 */
const datasetName = (
  dataset: ResourceInput<Dataset> | string,
): Effect.Effect<Input<string>> =>
  typeof dataset === "string"
    ? Effect.succeed(dataset)
    : Effect.map(instance(dataset), (resolved) => resolved.name);

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
 * // Beyond what this preset exposes, drop to the primitive and write the
 * // configuration out. Every component is validated at the call that
 * // declares it, and the config sections are derived from the pipelines.
 * AWS.Lambda.Collector({
 *   config: AWS.Lambda.collector({
 *     pipelines: {
 *       traces: AWS.Lambda.pipeline({
 *         receivers: [
 *           AWS.Lambda.Receiver.otlp({
 *             protocols: { http: { endpoint: "127.0.0.1:4318" } },
 *           }),
 *         ],
 *         processors: [
 *           AWS.Lambda.Processor.memoryLimiter({
 *             checkInterval: Duration.seconds(1),
 *             limitMib: 128,
 *           }),
 *           // Sample before export to cut ingest volume.
 *           AWS.Lambda.Processor.probabilisticSampler({
 *             samplingPercentage: 10,
 *           }),
 *           AWS.Lambda.Processor.batch({ timeout: Duration.seconds(1) }),
 *           AWS.Lambda.Processor.decouple({ maxQueueSize: 200 }),
 *         ],
 *         exporters: [
 *           AWS.Lambda.Exporter.otlpHttp("axiom", {
 *             endpoint: "https://api.axiom.co",
 *             compression: "zstd",
 *             headers: {
 *               // Redacted in, Redacted out: the prefix is applied inside the
 *               // secret, so the credential never enters the layer archive.
 *               authorization: Output.map(ingest.token, (t) =>
 *                 Redacted.make(`Bearer ${Redacted.value(t)}`),
 *               ),
 *               "x-axiom-dataset": traces.name,
 *             },
 *           }),
 *         ],
 *       }),
 *     },
 *   }),
 * })
 * ```
 */
export const LambdaCollector = (
  props: AxiomLambdaCollectorProps,
): Layer.Layer<never> =>
  // `Layer.fresh` for the same reason as `AWS.Lambda.Collector`: attaching is
  // a build-time side effect against the ambient host, so one preset value
  // shared by several Functions must rebuild per host instead of memoizing
  // the first host's build.
  Layer.fresh(
    Layer.unwrap(
      Effect.gen(function* () {
        // Declarations are yielded to instances (registering them on the Stack
        // if this host is the first to reference them) so the accessors below
        // produce real Outputs.
        const token = yield* instance(props.token);
        const traces = yield* datasetName(props.traces);
        const logs = yield* datasetName(props.logs);
        return Collector({
          config: axiomCollectorConfig({
            // Each of these routes itself at emission: a literal endpoint or
            // a pre-existing dataset name bakes into the layer, while an
            // `Output` from an `Axiom.Dataset` becomes a generated env var,
            // so a renamed dataset reconfigures the Function instead of
            // republishing the layer.
            endpoint: props.endpoint ?? DEFAULT_OTLP_ENDPOINT,
            // Built once and shared by both exporters, so the emitter binds
            // it to ONE environment variable. `ApiToken.token` is `Redacted`
            // and stays that way through the prefixing, so the credential
            // rides the secret channel and never enters the layer archive.
            authorization: bearerToken(token.token),
            tracesDataset: traces,
            logsDataset: logs,
          }),
          configId: props.configId,
          extension: props.extension,
          disabled: props.disabled,
          serviceName: props.serviceName,
        });
        // Its own span, nesting the `collector.attach` one: a deploy trace
        // then shows whether the token/dataset resolution or the extension
        // attachment is the slow half.
      }).pipe(Effect.withSpan("collector.axiom")),
    ),
  ) as Layer.Layer<never>;
