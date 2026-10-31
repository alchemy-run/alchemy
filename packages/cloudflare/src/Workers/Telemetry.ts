import type { Input } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import type { ResourceBinding } from "alchemy/Resource";
import * as AlchemyTelemetry from "alchemy/Telemetry";
/**
 * Cloudflare Workers Observability tracer as a binding layer — the
 * platform-native counterpart of `Axiom.Telemetry`.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { layer as cloudflareTracerLayer } from "./CloudflareTracer.ts";
import { getCompatibility } from "./Compatibility.ts";
import { Worker, type WorkerProps } from "./Worker.ts";

/**
 * Earliest compatibility date that exposes `tracing.startActiveSpan`
 * (`cloudflare:workers`). ISO dates compare lexically.
 */
export const MIN_CLOUDFLARE_TRACING_DATE = "2026-07-28";

/**
 * Thrown when {@link Telemetry} is provided on a Worker whose resolved
 * compatibility date is older than {@link MIN_CLOUDFLARE_TRACING_DATE}.
 */
export class CloudflareTelemetryCompatibilityError extends Data.TaggedError(
  "CloudflareTelemetryCompatibilityError",
)<{
  date: string;
  minimumDate: string;
}> {
  override get message() {
    return (
      `Cloudflare.Telemetry() requires compatibility date >= ${this.minimumDate} ` +
      `(tracing.startActiveSpan). This Worker is pinned to ${this.date}. ` +
      `Set compatibility: { date: "${this.minimumDate}" } (or later) on the Worker.`
    );
  }
}

export interface CloudflareTelemetryProps {
  /**
   * Enable Workers Traces on the host Worker.
   * @default true
   */
  enabled?: boolean;
  /**
   * Head-based sampling rate for Workers Traces (`0`–`1`).
   * Omitted unless set — Cloudflare's default applies.
   */
  headSamplingRate?: number;
  /**
   * Persist traces in the Cloudflare dashboard. Omitted unless set.
   * Pass `false` to export-only (no dashboard persist).
   */
  persist?: boolean;
  /**
   * Workers Logs settings for the host Worker. Logs are on by default;
   * pass `{ enabled: false }` to turn them off. Merged field by field
   * with `observability.logs` on the Worker's props; a field set to
   * different values in both fails the deploy.
   * @default { enabled: true, invocationLogs: true }
   */
  logs?: CloudflareTelemetryLogsProps;
}

export interface CloudflareTelemetryLogsProps {
  /**
   * Enable Workers Logs on the host Worker.
   * @default true
   */
  enabled?: boolean;
  /**
   * Record an invocation log for every request.
   * @default true
   */
  invocationLogs?: boolean;
  /**
   * Head-based sampling rate for Workers Logs (`0`–`1`).
   * Omitted unless set — Cloudflare's default applies.
   */
  headSamplingRate?: number;
  /**
   * Persist logs in the Cloudflare dashboard. Omitted unless set.
   * Pass `false` to export-only (no dashboard persist).
   */
  persist?: boolean;
  /**
   * Slugs of `Cloudflare.Workers.ObservabilityDestination`s
   * (`logpushDataset: "opentelemetry-logs"`) to export logs to.
   */
  destinations?: Input<string>[];
}

const defined = <T extends object>(fields: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Partial<T>;

// Only the fields the caller set: the Worker fills in the defaults, and
// merges these with its own `observability` props field by field.
const tracesFromProps = (props: CloudflareTelemetryProps) =>
  defined({
    enabled: props.enabled,
    headSamplingRate: props.headSamplingRate,
    persist: props.persist,
  });

const logsFromProps = ({ logs = {} }: CloudflareTelemetryProps) =>
  defined({
    enabled: logs.enabled,
    invocationLogs: logs.invocationLogs,
    headSamplingRate: logs.headSamplingRate,
    persist: logs.persist,
    destinations: logs.destinations,
  });

/**
 * Fail deploy when `Cloudflare.Telemetry()` is bound and the Worker's
 * resolved compatibility date is too old for `tracing.startActiveSpan`.
 *
 * @internal
 */
export const assertCloudflareTelemetryCompatibility = (
  news: WorkerProps,
  bindings: ReadonlyArray<ResourceBinding<Worker["Binding"]>>,
): Effect.Effect<void, CloudflareTelemetryCompatibilityError> => {
  const hasBind = bindings.some((b) => b.data.observability?.traces != null);
  if (!hasBind) return Effect.void;
  const { date } = getCompatibility(news);
  if (date >= MIN_CLOUDFLARE_TRACING_DATE) return Effect.void;
  return Effect.fail(
    new CloudflareTelemetryCompatibilityError({
      date,
      minimumDate: MIN_CLOUDFLARE_TRACING_DATE,
    }),
  );
};

/**
 * Mirror Effect spans into Cloudflare Workers Observability.
 *
 * A binding layer: at deploy time it turns on `observability.traces` and
 * `observability.logs` on the host Worker (the same path as `Cloudflare.cache()`) and registers a
 * per-event Effect Tracer. Cloudflare auto-instruments fetch/KV/R2/D1;
 * `Effect.withSpan` / `Effect.fn` frames nest in that waterfall. Cloudflare
 * owns sampling and export — no OTLP URL, flush, or Wrangler block.
 *
 * Until the global default compatibility date is raised past 2026-07-28,
 * pin `compatibility: { date: "2026-08-25" }` (or later) or deploy fails.
 * `alchemy dev` does not gate the date: what a local Worker records is the
 * local runtime's concern.
 *
 * Compose it into the Function/Worker's single `Effect.provide`:
 *
 * ### Enabling native tracing
 * **Example:** Effect spans in the Workers Observability waterfall
 * ```typescript
 * export default Cloudflare.Worker(
 *   "Worker",
 *   {
 *     main: import.meta.url,
 *     compatibility: { date: "2026-08-25" },
 *   },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* doWork().pipe(Effect.withSpan("operation"));
 *         return HttpServerResponse.text("ok");
 *       }),
 *     };
 *   }).pipe(
 *     Effect.provide(
 *       Layer.mergeAll(
 *         Cloudflare.R2.ReadWriteBucketBinding,
 *         Cloudflare.Telemetry(),
 *       ),
 *     ),
 *   ),
 * );
 * ```
 *
 * ### Configuring Workers Logs
 * **Example:** Export logs to an OTLP collector without dashboard persist
 * ```typescript
 * const logs = yield* Cloudflare.Workers.ObservabilityDestination("Logs", {
 *   url: "https://otel.example.com/v1/logs",
 *   logpushDataset: "opentelemetry-logs",
 * });
 *
 * Effect.provide(
 *   Cloudflare.Telemetry({
 *     logs: { persist: false, destinations: [logs.slug] },
 *   }),
 * )
 * ```
 *
 * **Example:** Traces only, with Workers Logs off
 * ```typescript
 * Effect.provide(Cloudflare.Telemetry({ logs: { enabled: false } }))
 * ```
 *
 * ### Combining with other exporters
 * **Example:** Native traces plus another exporter's logs and metrics
 * ```typescript
 * Effect.provide(
 *   Layer.mergeAll(
 *     Cloudflare.Telemetry(),
 *     // omit `traces` — Cloudflare.Telemetry provides the Tracer
 *     Axiom.Telemetry({ token: Ingest, logs: Logs, metrics: Metrics }),
 *   ),
 * )
 * ```
 *
 * To ship the same waterfall (Effect + platform spans) elsewhere, export
 * it from Cloudflare with `Cloudflare.Workers.ObservabilityDestination`
 * rather than sending a second Worker-side OTLP trace stream.
 *
 * @layer
 * @provides Tracer.Tracer
 * @product Workers
 * @category Workers & Compute
 */
export const Telemetry = (
  props: CloudflareTelemetryProps = {},
): Layer.Layer<never, never, Worker> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const host = yield* Worker;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          host.bind("Cloudflare.Telemetry", {
            observability: { traces: tracesFromProps(props), logs: logsFromProps(props) },
          }),
        );
      }
      // The runtime bridges build the registered Layer per event with a
      // forked MemoMap, so the Tracer is naturally fresh per invocation.
      return AlchemyTelemetry.layer(cloudflareTracerLayer);
    }),
  );
