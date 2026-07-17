/**
 * OpenTelemetry export for deployed Functions/Workers, built on Effect's
 * OTLP exporters (`effect/unstable/observability`) and configured through
 * alchemy's binding infrastructure — exporters are Layers, and their
 * configuration (endpoints, tokens) is wired from resource Outputs like any
 * other binding.
 *
 * Provide a telemetry Layer on the Function/Worker init Effect, composed
 * into the single `Effect.provide` alongside the other binding layers:
 *
 * ```ts
 * import * as Alchemy from "alchemy";
 * import * as Axiom from "alchemy/Axiom";
 *
 * Effect.gen(function* () {
 *   // ...
 * }).pipe(
 *   Effect.provide(
 *     Layer.mergeAll(
 *       Cloudflare.R2.ReadWriteBucketBinding,
 *       // vendor sugar — binds dataset endpoints + ingest token:
 *       Axiom.Telemetry({ token: Ingest, traces: Traces, logs: Logs }),
 *       // or the generic OTLP form, wired from any Inputs/Outputs:
 *       // Alchemy.Telemetry.otlp({ url: collector.url, headers: { ... } }),
 *       // or any custom exporter Layer:
 *       // Alchemy.Telemetry.layer(myExporterLayer),
 *     ),
 *   ),
 * );
 * ```
 *
 * {@link Telemetry.otlp} is a *binding* layer: at deploy time it binds the
 * configured endpoints/headers onto the host (Redacted values as secrets),
 * and at runtime the exporter reads those bound values back. Telemetry is
 * off until a layer is provided — Effect's default tracer is a no-op, so
 * all instrumentation stays free.
 *
 * `Telemetry` itself is a `Context.Reference` holding the Layer of
 * exporters to install for every event (fetch, queue, cron, RPC, Durable
 * Object call, Workflow run, Lambda invoke). The runtime bridges build that
 * Layer into the event's request scope, so:
 *
 * - the exporter's batching fiber runs inside the event's I/O context
 *   (required on workerd, where timers/fetches are pinned to the request),
 * - buffered spans/logs/metrics are flushed when the request scope
 *   finalizes — registered with `ctx.waitUntil`, so flushing never delays
 *   the response.
 */
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import * as OtlpLogger from "effect/unstable/observability/OtlpLogger";
import * as OtlpMetrics from "effect/unstable/observability/OtlpMetrics";
import * as OtlpSerialization from "effect/unstable/observability/OtlpSerialization";
import * as OtlpTracer from "effect/unstable/observability/OtlpTracer";
import type { Input } from "./Input.ts";
import * as Output from "./Output.ts";
import { CurrentRuntimeContext, unpackEnvValue } from "./RuntimeContext.ts";

/**
 * The shape of the {@link Telemetry} reference: a Layer of telemetry
 * exporters (tracer, loggers, metrics) built once per event into the
 * event's request scope. Requirements are satisfied from the runtime's
 * isolate context (`HttpClient`, `ConfigProvider`, …).
 */
export type TelemetryLayer = Layer.Layer<never, any, any>;

/**
 * Read one bound value back at runtime. `rc.set` packs values for the env
 * var wire (plain values JSON-stringified, `Redacted` as a marker routed
 * through the secret channel), so the raw env string must be unpacked with
 * {@link unpackEnvValue} — it handles all three shapes (packed JSON,
 * Redacted marker, and a raw string set directly in the environment).
 */
const readBound = (key: string): Effect.Effect<string | undefined> =>
  Config.string(key).pipe(
    Config.withDefault(undefined),
    Effect.orElseSucceed(() => undefined),
    Effect.map((raw) => {
      if (raw === undefined || raw === "") {
        return undefined;
      }
      const value = unpackEnvValue<unknown>(raw);
      const inner = Redacted.isRedacted(value) ? Redacted.value(value) : value;
      return inner === undefined
        ? undefined
        : typeof inner === "string"
          ? inner
          : String(inner);
    }),
  );

/**
 * `service.name` fallback chain for the default exporter: the standard
 * OTEL variable, then the physical Function/Worker name, then the stack
 * name. `OtlpResource.fromConfig` dies without a service name, so the
 * chain must always produce one.
 */
const defaultServiceName = Effect.gen(function* () {
  return (
    (yield* readBound("OTEL_SERVICE_NAME")) ??
    (yield* readBound("ALCHEMY_WORKER_NAME")) ??
    (yield* readBound("AWS_LAMBDA_FUNCTION_NAME")) ??
    (yield* readBound("ALCHEMY_STACK_NAME")) ??
    "alchemy"
  );
});

const defaultResource = Effect.gen(function* () {
  const serviceName = yield* defaultServiceName;
  const stack = yield* readBound("ALCHEMY_STACK_NAME");
  const stage = yield* readBound("ALCHEMY_STAGE");
  return {
    serviceName,
    attributes: {
      ...(stack !== undefined ? { "alchemy.stack": stack } : undefined),
      ...(stage !== undefined ? { "alchemy.stage": stage } : undefined),
    },
  };
});

/**
 * Parse the OpenTelemetry `OTEL_EXPORTER_OTLP_HEADERS` format:
 * `key1=value1,key2=value2` with URL-encoded values.
 */
const parseOtlpHeaders = (
  raw: string | undefined,
): Record<string, string> | undefined => {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const headers: Record<string, string> = {};
  for (const entry of raw.split(",")) {
    const eq = entry.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = entry.slice(0, eq).trim();
    if (key === "") {
      continue;
    }
    const value = entry.slice(eq + 1).trim();
    try {
      headers[key] = decodeURIComponent(value);
    } catch {
      headers[key] = value;
    }
  }
  return headers;
};

/**
 * Resolve one signal's OTLP endpoint + headers from the standard env vars:
 * `OTEL_EXPORTER_OTLP_{SIGNAL}_ENDPOINT` is used as-is; otherwise the base
 * `OTEL_EXPORTER_OTLP_ENDPOINT` gets `/v1/{signal}` appended (matching the
 * OpenTelemetry SDK spec). Headers fall back per-signal → base.
 */
const signalConfig = (signal: "TRACES" | "LOGS" | "METRICS") =>
  Effect.gen(function* () {
    const specific = yield* readBound(`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`);
    const base = yield* readBound("OTEL_EXPORTER_OTLP_ENDPOINT");
    const url =
      specific !== undefined && specific !== ""
        ? specific
        : base !== undefined && base !== ""
          ? `${base.replace(/\/$/, "")}/v1/${signal.toLowerCase()}`
          : undefined;
    if (url === undefined) {
      return undefined;
    }
    const rawHeaders =
      (yield* readBound(`OTEL_EXPORTER_OTLP_${signal}_HEADERS`)) ??
      (yield* readBound("OTEL_EXPORTER_OTLP_HEADERS"));
    return { url, headers: parseOtlpHeaders(rawHeaders) };
  });

const makeFromEnv = (options?: {
  exportInterval?: Duration.Input;
}): TelemetryLayer =>
  Layer.unwrap(
    Effect.gen(function* () {
      const [traces, logs, metrics] = yield* Effect.all([
        signalConfig("TRACES"),
        signalConfig("LOGS"),
        signalConfig("METRICS"),
      ]);
      if (traces === undefined && logs === undefined && metrics === undefined) {
        return Layer.empty;
      }
      const resource = yield* defaultResource;
      const layers: Layer.Layer<never, never, any>[] = [];
      if (traces !== undefined) {
        layers.push(
          OtlpTracer.layer({
            url: traces.url,
            headers: traces.headers,
            resource,
            exportInterval: options?.exportInterval,
          }),
        );
      }
      if (logs !== undefined) {
        layers.push(
          OtlpLogger.layer({
            url: logs.url,
            headers: logs.headers,
            resource,
            exportInterval: options?.exportInterval,
          }),
        );
      }
      if (metrics !== undefined) {
        layers.push(
          OtlpMetrics.layer({
            url: metrics.url,
            headers: metrics.headers,
            resource,
            exportInterval: options?.exportInterval,
          }),
        );
      }
      return Layer.mergeAll(...(layers as [Layer.Layer<never>])).pipe(
        Layer.provide(OtlpSerialization.layerJson),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "Invalid OTEL_* telemetry configuration; telemetry disabled",
          cause,
        ).pipe(Effect.as(Layer.empty)),
      ),
    ),
  );

/**
 * The runtime half of the {@link Telemetry.otlp} binding, and the default
 * per-event Layer: reads the bound `OTEL_EXPORTER_OTLP_*` values back and
 * constructs the OTLP JSON exporters. Each signal resolves independently;
 * only configured signals export; resolves to `Layer.empty` when nothing is
 * bound, so telemetry is free until a layer is provided.
 *
 * The periodic export intervals are effectively disabled: the exporter is
 * built per event and the request-scope flush delivers everything. An
 * interval export firing mid-event would race the scope close — the close
 * interrupts the exporter's in-flight batch (already spliced out of the
 * buffer), silently dropping it. Lambda invocations regularly outlive the
 * 1-second logger interval, which is exactly how this was discovered.
 *
 * A malformed configuration degrades to `Layer.empty` with a warning
 * instead of failing the event.
 */
const fromBoundConfig: TelemetryLayer = makeFromEnv({
  exportInterval: "1 hour",
});

/**
 * The process-runtime half of the binding: same bound-value resolution with
 * the standard periodic export intervals, since a server's root scope only
 * flushes at shutdown.
 */
const fromBoundConfigProcess: TelemetryLayer = makeFromEnv();

const reference = Context.Reference<TelemetryLayer>("alchemy/Telemetry", {
  defaultValue: () => fromBoundConfig,
});

/**
 * Install a custom telemetry Layer (any Layer providing a `Tracer`,
 * loggers, and/or metric exporters). It is built once per event into the
 * event's request scope, so scoped exporters flush when the request scope
 * finalizes.
 *
 * Provide it on the Function/Worker's init Effect
 * (`Effect.provide(Telemetry.layer(...))`): building the returned Layer
 * registers the exporter Layer on the current runtime context, where the
 * runtime bridges pick it up per event. Handlers' request-time context is
 * assembled by the bridge, so a plain `Layer.succeed` of the reference on
 * the init Effect would never reach them — the registration is what makes
 * the override visible at request time.
 */
const telemetryLayer = (layer: TelemetryLayer): Layer.Layer<never> =>
  Layer.effect(
    reference,
    Effect.gen(function* () {
      const ctx = yield* CurrentRuntimeContext;
      if (ctx !== undefined) {
        ctx.telemetry = layer;
      }
      return layer;
    }),
  );

/**
 * A header value: a plain string, a `Redacted` secret, or an Output of
 * either (e.g. an ApiToken's `token` attribute).
 */
export type OtlpHeaderValue = Input<string | Redacted.Redacted<string>>;

/**
 * OTLP configuration for one signal. `url` and header values accept plain
 * values or resource Outputs — they are *bound* onto the host at deploy
 * time like any other binding.
 */
export interface OtlpSignalOptions {
  /** The OTLP/HTTP URL exports for this signal are POSTed to. */
  url: Input<string>;
  /**
   * Headers sent with each export request (e.g. auth tokens). `Redacted`
   * values bind as secrets.
   */
  headers?: Record<string, OtlpHeaderValue> | undefined;
}

/**
 * Options for {@link Telemetry.otlp}. Configure a base `url` (with
 * `/v1/{signal}` appended per signal), per-signal urls, or a mix — a
 * per-signal entry takes precedence over the base.
 */
export interface OtlpOptions {
  /** Base OTLP/HTTP URL; `/v1/{traces,logs,metrics}` is appended per signal. */
  url?: Input<string> | undefined;
  /** Headers for every signal; per-signal `headers` take precedence. */
  headers?: Record<string, OtlpHeaderValue> | undefined;
  traces?: OtlpSignalOptions | undefined;
  logs?: OtlpSignalOptions | undefined;
  metrics?: OtlpSignalOptions | undefined;
  /**
   * The exported `service.name`.
   * @default the deployed Function/Worker's physical name
   */
  serviceName?: Input<string> | undefined;
}

/**
 * Serialize a headers record into the OTLP `k=v,k2=v2` wire form as a
 * single Output. If any value is `Redacted` the whole composed value is
 * `Redacted`, so it binds as a secret.
 */
const headersValue = (
  headers: Record<string, OtlpHeaderValue>,
): Output.Output<string | Redacted.Redacted<string>> => {
  const keys = Object.keys(headers);
  return (
    Output.all(
      ...keys.map((key) => Output.asOutput(headers[key] as never)),
    ) as Output.Output<(string | Redacted.Redacted<string>)[]>
  ).pipe(
    Output.map((values) => {
      let secret = false;
      const parts = keys.map((key, i) => {
        let value = values[i];
        if (Redacted.isRedacted(value)) {
          secret = true;
          value = Redacted.value(value);
        }
        // Escape the OTLP headers-format delimiters; the runtime read side
        // URL-decodes values (per the OpenTelemetry spec).
        return `${key}=${/[,=]/.test(value) ? encodeURIComponent(value) : value}`;
      });
      const joined = parts.join(",");
      return secret ? Redacted.make(joined) : joined;
    }),
  );
};

/**
 * The built-in OTLP exporter as a *binding* layer.
 *
 * At deploy time, building this layer binds the configured urls and
 * headers onto the host Function/Worker (Redacted values as secret
 * bindings) — url and header values accept resource Outputs, so exporter
 * config is wired from resources like any other binding. At runtime the
 * exporter reads the bound values back and ships traces, logs, and metrics
 * over OTLP/HTTP JSON, flushed as each event's scope closes.
 *
 * Compose it into the Function/Worker's single `Effect.provide`:
 *
 * ```ts
 * Effect.provide(
 *   Layer.mergeAll(
 *     Cloudflare.R2.ReadWriteBucketBinding,
 *     Alchemy.Telemetry.otlp({
 *       url: "https://api.honeycomb.io",
 *       headers: { "x-honeycomb-team": apiKey },
 *     }),
 *   ),
 * )
 * ```
 *
 * Vendor sugar can wrap this — e.g. `Axiom.Telemetry({ token, traces })`
 * binds Axiom dataset endpoints and an ingest token.
 */
const otlp = (options: OtlpOptions): Layer.Layer<never> =>
  Layer.effect(
    reference,
    Effect.gen(function* () {
      const rc = yield* CurrentRuntimeContext;
      if (rc !== undefined && !globalThis.__ALCHEMY_RUNTIME__) {
        const bind = (
          key: string,
          value: Input<string | Redacted.Redacted<string>> | undefined,
        ) =>
          value === undefined
            ? Effect.void
            : Effect.asVoid(rc.set(key, Output.asOutput(value as never)));
        const bindSignal = (
          name: "TRACES" | "LOGS" | "METRICS",
          signal: OtlpSignalOptions | undefined,
        ) =>
          Effect.all([
            bind(`OTEL_EXPORTER_OTLP_${name}_ENDPOINT`, signal?.url),
            bind(
              `OTEL_EXPORTER_OTLP_${name}_HEADERS`,
              signal?.headers && headersValue(signal.headers),
            ),
          ]);
        yield* Effect.all([
          bind("OTEL_EXPORTER_OTLP_ENDPOINT", options.url),
          bind(
            "OTEL_EXPORTER_OTLP_HEADERS",
            options.headers && headersValue(options.headers),
          ),
          bindSignal("TRACES", options.traces),
          bindSignal("LOGS", options.logs),
          bindSignal("METRICS", options.metrics),
          bind("OTEL_SERVICE_NAME", options.serviceName),
        ]);
      }
      // The runtime half reads the bound values back per event (or once per
      // process via `provideProcessTelemetry`).
      return fromBoundConfig;
    }),
  );

/**
 * The per-event telemetry exporters, as a `Context.Reference` holding the
 * Layer the runtime bridges build into every event's request scope. See
 * the module documentation for how to provide one.
 */
export const Telemetry = Object.assign(reference, {
  /** Install a custom telemetry Layer. */
  layer: telemetryLayer,
  /** The built-in OTLP exporter as a binding layer. */
  otlp,
});

/**
 * Build the configured {@link Telemetry} Layer into an event's request
 * scope, returning the Context of telemetry services to provide to the
 * event's handler effect.
 *
 * Called by the runtime bridges (Worker, Durable Object, Workflow, Lambda)
 * once per event. Building into the *request* scope — not the
 * never-finalized isolate scope — is what makes export work on workerd:
 * the batching fiber lives inside the event's I/O context and the final
 * flush runs from the scope's finalizer, which the bridges register with
 * `ctx.waitUntil`.
 *
 * A failed build (bad user Layer, config error) degrades to an empty
 * Context with a warning instead of failing the event.
 *
 * `override` is the Layer registered on the runtime context by
 * {@link Telemetry.layer} during init; when absent the reference (and so
 * the env-driven default) applies.
 *
 * Declared `R = never`: the Layer's actual requirements (`HttpClient`,
 * `ConfigProvider`, …) are satisfied at runtime by the bridge's surrounding
 * `Effect.provide` of the built runtime context.
 */
export const buildEventTelemetry = (
  context: Context.Context<never>,
  scope: Scope.Scope,
  override?: TelemetryLayer | undefined,
): Effect.Effect<Context.Context<never>> =>
  Effect.suspend(() =>
    Layer.buildWithScope(override ?? Context.get(context, reference), scope),
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to build telemetry layer", cause).pipe(
        Effect.as(Context.empty()),
      ),
    ),
  ) as Effect.Effect<Context.Context<never>>;

/**
 * Provide telemetry to a long-running server process (Cloudflare Container,
 * ECS Task, EC2 host, Lambda microVM).
 *
 * Unlike the per-event runtime bridges, server processes have no I/O-context
 * pinning and a real shutdown: the configured {@link Telemetry} Layer is
 * built ONCE into the ambient root scope, exporters batch on their intervals
 * for the life of the process, and the final flush runs when the root scope
 * closes on graceful exit.
 *
 * `runtimeContext` is the entrypoint's runtime context; its `telemetry`
 * field carries the override registered by {@link Telemetry.layer} during
 * init. Without an override the bound-config exporter (with standard
 * periodic export intervals) applies.
 */
export const provideProcessTelemetry =
  (runtimeContext?: { telemetry?: TelemetryLayer | undefined }) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R | Scope.Scope> =>
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const scope = yield* Effect.scope;
      const telemetry = yield* buildEventTelemetry(
        context,
        scope,
        runtimeContext?.telemetry ?? fromBoundConfigProcess,
      );
      return yield* Effect.provideContext(effect, telemetry);
    });
