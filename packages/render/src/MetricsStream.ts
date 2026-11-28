import * as RenderSdk from "@distilled.cloud/render";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Api from "./internal/Api.ts";
import { toRedacted } from "./internal/Redacted.ts";
import type { Providers } from "./Providers.ts";
import type { OtelProviderType, SecretString } from "./Types.ts";

export interface MetricsStreamProps {
  /** Optional Render workspace/owner ID. Defaults to the configured profile or the sole owner on `/owners`. */
  ownerId?: string;
  /** OpenTelemetry metrics provider target (`BETTER_STACK`, `CUSTOM`, `DATADOG`, `GRAFANA`, `GROUNDCOVER`, `HONEYCOMB`, `NEW_RELIC`, `SIGNOZ`). */
  provider: OtelProviderType;
  /** OTLP HTTP metrics endpoint URL. */
  url: string;
  /** Bearer / API token sent to authenticate metric exports. */
  token: SecretString;
}

export interface MetricsStreamAttributes {
  /** Workspace/owner ID owning this metrics stream singleton. */
  ownerId: string;
  /** Configured OTEL provider type. */
  provider: OtelProviderType;
  /** OTLP endpoint URL. */
  url: string;
  /** Redacted metrics ingestion token retained in state. */
  token?: Redacted.Redacted<string>;
}

export interface MetricsStreamLookup {
  /** Optional owner ID whose workspace metrics stream setting should be read. */
  ownerId?: string;
}

export type MetricsStream = Resource<
  "Render.MetricsStream",
  MetricsStreamProps,
  MetricsStreamAttributes,
  never,
  Providers,
  MetricsStreamLookup
>;

/**
 * Configures the workspace-wide OpenTelemetry metrics stream exporting service
 * and datastore metrics to an external observability provider.
 *
 * This is a workspace singleton; deleting it removes the metrics stream integration.
 *
 * **Example:** Export OTEL metrics to Grafana Cloud
 * ```typescript
 * yield* Render.MetricsStream("OtelMetrics", {
 *   provider: "GRAFANA",
 *   url: "https://otlp-gateway.grafana.net/otlp",
 *   token: yield* Config.Redacted("GRAFANA_OTLP_TOKEN"),
 * });
 * ```
 *
 * @resource
 * @product Observability
 * @category Observability & Events
 */
export const MetricsStream = Resource<MetricsStream>("Render.MetricsStream");

export const MetricsStreamProvider = () =>
  Provider.effect(
    MetricsStream,
    Effect.succeed({
      stables: ["ownerId"],
      nuke: { singleton: true },
      diff: Effect.fn(function* ({ news }) {
        if (!isResolved(news)) return undefined;
        return undefined;
      }),
      read: Effect.fn(function* ({ olds, output }) {
        const explicitOwnerId =
          typeof olds?.ownerId === "string" && olds.ownerId.length > 0 ? olds.ownerId : undefined;
        const ownerId = output?.ownerId ?? (yield* Api.resolveOwnerId(explicitOwnerId));
        const stream = yield* Api.ignoreNotFound(RenderSdk.getOwnerMetricsStream({ ownerId }));
        if (!stream || !stream.url) return undefined;
        return {
          ownerId: stream.ownerId ?? ownerId,
          provider: stream.provider as OtelProviderType,
          url: stream.url,
          ...(output?.token !== undefined ? { token: output.token } : {}),
        };
      }),
      lookup: Effect.fn(function* (props) {
        const ownerId = yield* Api.resolveOwnerId(props.ownerId);
        const stream = yield* Api.ignoreNotFound(RenderSdk.getOwnerMetricsStream({ ownerId }));
        if (!stream || !stream.url) return undefined;
        return {
          ownerId: stream.ownerId ?? ownerId,
          provider: stream.provider as OtelProviderType,
          url: stream.url,
        };
      }),
      list: Effect.fn(function* () {
        return [];
      }),
      reconcile: Effect.fn(function* ({ news }) {
        const ownerId = yield* Api.resolveOwnerId(news.ownerId);
        const token = toRedacted(news.token);
        const updated = yield* RenderSdk.upsertOwnerMetricsStream({
          ownerId,
          provider: news.provider,
          url: news.url,
          token,
        });
        return {
          ownerId: updated.ownerId ?? ownerId,
          provider: (updated.provider ?? news.provider) as OtelProviderType,
          url: updated.url ?? news.url,
          token,
        };
      }),
      delete: Effect.fn(function* ({ output }) {
        if (!output?.ownerId) return;
        yield* Api.deleteIdempotent(
          RenderSdk.deleteOwnerMetricsStream({ ownerId: output.ownerId }),
        );
      }),
    }),
  );
