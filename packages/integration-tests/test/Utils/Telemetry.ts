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
