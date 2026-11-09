import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Telemetry from "alchemy/Telemetry";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import type { OtelSink } from "./fixtures/otel-collector-worker.ts";

/**
 * Shared pieces for the "a deployed runtime exports its spans" cases: an OTLP
 * collector Worker on workers.dev (reachable from every cloud), the telemetry
 * Layer a traced program provides, a `fetch` handler that makes one span per
 * request, and a poller that reads the collected traces back.
 */

/** The OTLP sink. Declare it in every deploy step of a test so later deploys keep it. */
export const OtelCollector = () =>
  Cloudflare.Worker("OtelCollector", {
    main: pathe.resolve(import.meta.dirname, "fixtures/otel-collector-worker.ts"),
    env: { SINK: Cloudflare.DurableObject<OtelSink>("OtelSink") },
  });

/**
 * Run a deploy with `COLLECTOR_URL` in the deployer's config, so a program
 * providing {@link CollectorTelemetry} binds the collector as its destination.
 */
export const withCollectorUrl = (url: string) =>
  Effect.fn(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
    const current = yield* ConfigProvider.ConfigProvider;
    return yield* Effect.provideService(
      effect,
      ConfigProvider.ConfigProvider,
      ConfigProvider.orElse(ConfigProvider.fromUnknown({ COLLECTOR_URL: url }), current),
    );
  });

/**
 * The telemetry a traced program provides: `COLLECTOR_URL` resolves from the
 * deployer's config at deploy time and binds onto the host.
 */
export const CollectorTelemetry = (serviceName: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const url = yield* Config.String("COLLECTOR_URL");
      return Telemetry.layerOtlp({ url, serviceName });
    }),
  );

/** `GET /work?tag=<tag>` makes one span named `work:<tag>`. */
export const tracedFetch = Effect.gen(function* () {
  const request = yield* HttpServerRequest;
  const url = new URL(request.url, "http://program");
  const tag = url.searchParams.get("tag") ?? "none";
  if (url.pathname === "/work") {
    yield* Effect.log(`work-log:${tag}`).pipe(Effect.withSpan(`work:${tag}`));
    return HttpServerResponse.text(`did work ${tag}`);
  }
  return HttpServerResponse.text("traced ok");
});

/**
 * Call `/work?tag=<tag>` on a traced program, retrying while its URL comes up.
 * `headers` carries a platform's access token (a cookie, a traffic token).
 */
export const doWork = Effect.fn(function* (
  url: string,
  tag: string,
  headers: Record<string, string> = {},
) {
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  return yield* client.get(`${url.replace(/\/$/, "")}/work?tag=${tag}`, { headers }).pipe(
    Effect.flatMap((response) => response.text),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }),
  );
});

/**
 * Poll the collector until a traces export contains the span `work:<tag>`,
 * and return every collected traces export as JSON text.
 */
export const waitForWorkSpan = Effect.fn(function* (collectorUrl: string, tag: string) {
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  const traces = client.get(`${collectorUrl.replace(/\/$/, "")}/collected`).pipe(
    Effect.flatMap((response) => response.json),
    Effect.map((body) =>
      JSON.stringify(
        (body as { items: { signal: string; payload: unknown }[] }).items.filter(
          (item) => item.signal === "traces",
        ),
      ),
    ),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }),
  );
  // Process exporters batch on an interval, so the span arrives within one.
  return yield* traces.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (json) => json.includes(`work:${tag}`),
      times: 20,
    }),
  );
});

// ---------------------------------------------------------------------------
// Runtime-to-runtime RPC: does a callee's span join its caller's trace?
// ---------------------------------------------------------------------------

/** The RPC surface a traced callee serves: `traced(tag)` makes `rpc-callee:<tag>`. */
export const tracedRpc = {
  traced: (tag: string) =>
    Effect.succeed(`traced ${tag}`).pipe(Effect.withSpan(`rpc-callee:${tag}`)),
};

/** Call a traced callee inside the caller's own span, `rpc-caller:<tag>`. */
export const callTraced = <E, R>(
  callee: { readonly traced: (tag: string) => Effect.Effect<string, E, R> },
  tag: string,
) => callee.traced(tag).pipe(Effect.withSpan(`rpc-caller:${tag}`));

/** `GET /rpc-traced?tag=<tag>` on a caller runtime: one traced call to its callee. */
export const tracedCallerFetch = <E, R>(callee: {
  readonly traced: (tag: string) => Effect.Effect<string, E, R>;
}) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const url = new URL(request.url, "http://caller");
    if (url.pathname === "/rpc-traced") {
      const tag = url.searchParams.get("tag") ?? "none";
      return HttpServerResponse.text(yield* callTraced(callee, tag));
    }
    return HttpServerResponse.text("traced caller ok");
  });

interface CollectedSpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
}

const collectedSpans = (body: unknown): ReadonlyArray<CollectedSpan> =>
  (body as { items: { signal: string; payload: any }[] }).items
    .filter((item) => item.signal === "traces")
    .flatMap((item) => item.payload.resourceSpans ?? [])
    .flatMap((resource: any) => resource.scopeSpans ?? [])
    .flatMap((scope: any) => (scope.spans ?? []) as CollectedSpan[]);

/** Whether `span`'s ancestors, followed through `all`, reach `ancestor`. */
const descendsFrom = (
  all: ReadonlyArray<CollectedSpan>,
  span: CollectedSpan,
  ancestor: CollectedSpan,
) => {
  const byId = new Map(all.map((s) => [s.spanId, s] as const));
  let current: CollectedSpan | undefined = span;
  for (let hops = 0; current !== undefined && hops < 16; hops++) {
    if (current.parentSpanId === ancestor.spanId) return true;
    current = current.parentSpanId === undefined ? undefined : byId.get(current.parentSpanId);
  }
  return false;
};

/**
 * Poll the collector until it holds both `rpc-caller:<tag>` and
 * `rpc-callee:<tag>`, then report whether the callee's span is in the caller's
 * trace and below the caller's span (a transport may add spans between them,
 * such as an HTTP client span).
 */
export const waitForRpcLink = Effect.fn(function* (collectorUrl: string, tag: string) {
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  const read = client.get(`${collectorUrl.replace(/\/$/, "")}/collected`).pipe(
    Effect.flatMap((response) => response.json),
    Effect.map(collectedSpans),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }),
  );
  const spans = yield* read.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (all) =>
        all.some((s) => s.name === `rpc-caller:${tag}`) &&
        all.some((s) => s.name === `rpc-callee:${tag}`),
      times: 20,
    }),
  );
  const caller = spans.find((s) => s.name === `rpc-caller:${tag}`);
  const callee = spans.find((s) => s.name === `rpc-callee:${tag}`);
  return {
    found: caller !== undefined && callee !== undefined,
    sameTrace: caller !== undefined && callee?.traceId === caller.traceId,
    belowCaller:
      caller !== undefined && callee !== undefined && descendsFrom(spans, callee, caller),
  };
});
