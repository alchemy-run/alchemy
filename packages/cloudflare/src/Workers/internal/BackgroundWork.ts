import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as OtlpExporter from "effect/observability/OtlpExporter";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";

/**
 * Told of every promise the current event hands to `waitUntil`, so the event
 * keeps its telemetry open until that work settles. Provided per event by
 * the Worker and Durable Object bridges, and read from the calling fiber, so
 * it works for a context captured at init too.
 *
 * @internal
 */
export class BackgroundWork extends Context.Service<
  BackgroundWork,
  (promise: Promise<unknown>) => void
>()("Cloudflare.Workers.BackgroundWork") {}

/**
 * Keep an event's telemetry open for the work it hands to `waitUntil`, which
 * runs after the event returns and records into the event's exporters.
 *
 * Once `scope` closes (by the bridge, or later by whoever ejected it),
 * `telemetryScope` closes in `waitUntil`: at once if the event started no
 * background work, as before. Otherwise the exporters first flush what the
 * event recorded, so its own telemetry never waits on the background work,
 * and close once every tracked promise has settled, including promises
 * tracked while waiting. Telemetry Layers without an OTLP `Flusher` skip the
 * early flush and export everything at close. An exporter whose early flush
 * fails disables itself, as on any failed export, so the background
 * telemetry is lost with it.
 *
 * Provide `track` as {@link BackgroundWork}, and hand the built telemetry
 * Context to `setTelemetry` so it can be flushed.
 *
 * @internal
 */
export const makeBackgroundWork = (options: {
  readonly scope: Scope.Scope;
  readonly telemetryScope: Scope.Closeable;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}) => {
  const background: Array<Promise<unknown>> = [];
  let telemetry = Context.empty();
  const settled = Effect.promise(async () => {
    for (let seen = 0; seen < background.length;) {
      const batch = background.slice(seen);
      seen = background.length;
      await Promise.allSettled(batch);
    }
  });
  // The metrics exporter posts even when it holds nothing, so an event
  // without background work keeps its single export. `flush` has no deadline
  // of its own; bound it like the bound exporters' shutdown.
  const flush = Effect.suspend(() =>
    background.length === 0
      ? Effect.void
      : Option.match(Context.getOption(telemetry, OtlpExporter.Flusher), {
          onNone: () => Effect.void,
          onSome: (flusher) => Effect.timeoutOption(flusher.flush, "10 seconds"),
        }),
  );
  const close = Effect.all([flush, settled], { concurrency: "unbounded", discard: true }).pipe(
    Effect.andThen(Scope.close(options.telemetryScope, Exit.void)),
  );
  Effect.runSync(
    Scope.addFinalizer(
      options.scope,
      Effect.sync(() => options.waitUntil(Effect.runPromise(close))),
    ),
  );
  return {
    track: (promise: Promise<unknown>): void => void background.push(promise),
    setTelemetry: (context: Context.Context<never>) =>
      Effect.sync(() => {
        telemetry = context;
      }),
  };
};
