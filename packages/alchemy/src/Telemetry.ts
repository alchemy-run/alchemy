/**
 * OpenTelemetry export for deployed Functions/Workers, built on Effect's
 * OTLP exporters (`effect/unstable/observability`).
 *
 * `Telemetry` is a `Context.Reference` holding the *Layer* of telemetry
 * exporters to install for every event (fetch, queue, cron, RPC, Durable
 * Object call, Workflow run). The runtime bridges build that Layer into the
 * event's request scope, so:
 *
 * - the exporter's batching fiber runs inside the event's I/O context
 *   (required on workerd, where timers/fetches are pinned to the request),
 * - buffered spans/logs/metrics are flushed when the request scope
 *   finalizes — registered with `ctx.waitUntil`, so flushing never delays
 *   the response.
 *
 * By default telemetry is on and configures itself from the standard
 * OpenTelemetry environment variables: set `OTEL_EXPORTER_OTLP_ENDPOINT`
 * (and optionally `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`) on the
 * Function/Worker and traces, logs, and metrics ship OTLP/HTTP JSON to it.
 * Without an endpoint the default resolves to `Layer.empty` and Effect's
 * no-op tracer keeps all instrumentation free. Set `OTEL_SDK_DISABLED=true`
 * to force it off.
 *
 * Override the exporter in code by providing the reference on the
 * Function/Worker init Effect:
 *
 * ```ts
 * import * as Alchemy from "alchemy";
 * import * as Otlp from "effect/unstable/observability/Otlp";
 *
 * // explicit OTLP endpoint (still built per event, flushed per request):
 * Effect.provide(Alchemy.Telemetry.otlp({
 *   baseUrl: "https://api.honeycomb.io",
 *   headers: { "x-honeycomb-team": "..." },
 * }))
 *
 * // any custom exporter Layer (e.g. protobuf serialization, another vendor):
 * Effect.provide(Alchemy.Telemetry.layer(Otlp.layerProtobuf({ baseUrl: "..." })))
 *
 * // force-disable, ignoring OTEL_* environment variables:
 * Effect.provide(Alchemy.Telemetry.disabled)
 * ```
 */
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Otlp from "effect/unstable/observability/Otlp";
import { CurrentRuntimeContext } from "./RuntimeContext.ts";

/**
 * The shape of the {@link Telemetry} reference: a Layer of telemetry
 * exporters (tracer, loggers, metrics) built once per event into the
 * event's request scope. Requirements are satisfied from the runtime's
 * isolate context (`HttpClient`, `ConfigProvider`, …).
 */
export type TelemetryLayer = Layer.Layer<never, any, any>;

/**
 * `service.name` fallback chain for the default exporter: the standard
 * OTEL variable, then the physical Function/Worker name, then the stack
 * name. `OtlpResource.fromConfig` dies without a service name, so the
 * chain must always produce one.
 */
const defaultServiceName = Config.string("OTEL_SERVICE_NAME").pipe(
  Config.orElse(() => Config.string("ALCHEMY_WORKER_NAME")),
  Config.orElse(() => Config.string("AWS_LAMBDA_FUNCTION_NAME")),
  Config.orElse(() => Config.string("ALCHEMY_STACK_NAME")),
  Config.withDefault("alchemy"),
);

const defaultResource = Effect.gen(function* () {
  const serviceName = yield* defaultServiceName;
  const stack = yield* Config.string("ALCHEMY_STACK_NAME").pipe(
    Config.withDefault(undefined),
  );
  const stage = yield* Config.string("ALCHEMY_STAGE").pipe(
    Config.withDefault(undefined),
  );
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

const makeFromEnv = (options?: {
  exportInterval?: Duration.Input;
}): TelemetryLayer =>
  Layer.unwrap(
    Effect.gen(function* () {
      const disabled = yield* Config.boolean("OTEL_SDK_DISABLED").pipe(
        Config.withDefault(false),
      );
      if (disabled) {
        return Layer.empty;
      }
      const baseUrl = yield* Config.string("OTEL_EXPORTER_OTLP_ENDPOINT").pipe(
        Config.withDefault(undefined),
      );
      if (baseUrl === undefined || baseUrl === "") {
        return Layer.empty;
      }
      const rawHeaders = yield* Config.string(
        "OTEL_EXPORTER_OTLP_HEADERS",
      ).pipe(Config.withDefault(undefined));
      const resource = yield* defaultResource;
      return Otlp.layerJson({
        baseUrl,
        headers: parseOtlpHeaders(rawHeaders),
        resource,
        loggerExportInterval: options?.exportInterval,
        metricsExportInterval: options?.exportInterval,
        tracerExportInterval: options?.exportInterval,
      });
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
 * The default telemetry Layer for per-event runtimes: OTLP/HTTP JSON export
 * of traces, logs, and metrics, configured entirely from environment
 * variables. Resolves to `Layer.empty` when `OTEL_EXPORTER_OTLP_ENDPOINT`
 * is unset or `OTEL_SDK_DISABLED=true`, so telemetry is on by default but
 * free until an endpoint is configured.
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
export const fromEnv: TelemetryLayer = makeFromEnv({
  exportInterval: "1 hour",
});

/**
 * The default telemetry Layer for long-running server processes: same
 * env-driven OTLP export with the standard periodic export intervals, since
 * the process root scope only flushes at shutdown.
 */
export const fromEnvProcess: TelemetryLayer = makeFromEnv();

const reference = Context.Reference<TelemetryLayer>("alchemy/Telemetry", {
  defaultValue: () => fromEnv,
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
 * Configure OTLP export explicitly instead of via `OTEL_*` environment
 * variables. Accepts the same options as `Otlp.layerJson`; when
 * `resource.serviceName` is omitted it falls back to the deployed
 * Function/Worker name.
 */
const otlp = (
  options: Parameters<typeof Otlp.layerJson>[0],
): Layer.Layer<never> =>
  telemetryLayer(
    Layer.unwrap(
      Effect.gen(function* () {
        if (options.resource?.serviceName !== undefined) {
          return Otlp.layerJson(options);
        }
        const resource = yield* defaultResource;
        return Otlp.layerJson({
          ...options,
          resource: { ...resource, ...options.resource },
        });
      }),
    ),
  );

/**
 * Disable telemetry for this Function/Worker regardless of `OTEL_*`
 * environment variables.
 */
const disabled: Layer.Layer<never> = telemetryLayer(Layer.empty);

/**
 * The per-event telemetry exporters, as a `Context.Reference` holding the
 * Layer the runtime bridges build into every event's request scope. See
 * the module documentation for the default behavior and override options.
 */
export const Telemetry = Object.assign(reference, {
  /** Install a custom telemetry Layer. */
  layer: telemetryLayer,
  /** Configure the built-in OTLP JSON exporter explicitly. */
  otlp,
  /** Disable telemetry regardless of `OTEL_*` environment variables. */
  disabled,
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
 * init. Without an override the process default ({@link fromEnvProcess},
 * with standard periodic export intervals) applies.
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
        runtimeContext?.telemetry ?? fromEnvProcess,
      );
      return yield* Effect.provideContext(effect, telemetry);
    });
