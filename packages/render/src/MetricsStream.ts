import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Client from "./internal/Client.ts";
import { toRedacted, unwrapOptionalSecret } from "./internal/Redacted.ts";
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
        const ownerId = output?.ownerId ?? (yield* Client.resolveOwnerId(explicitOwnerId));
        const stream = yield* Client.ignoreNotFound(Client.getOwnerMetricsStream(ownerId));
        if (!stream || !stream.url) return undefined;
        return {
          ownerId: stream.ownerId ?? ownerId,
          provider: stream.provider,
          url: stream.url,
          ...(output?.token !== undefined ? { token: output.token } : {}),
        };
      }),
      lookup: Effect.fn(function* (props) {
        const ownerId = yield* Client.resolveOwnerId(props.ownerId);
        const stream = yield* Client.ignoreNotFound(Client.getOwnerMetricsStream(ownerId));
        if (!stream || !stream.url) return undefined;
        return {
          ownerId: stream.ownerId ?? ownerId,
          provider: stream.provider,
          url: stream.url,
        };
      }),
      list: Effect.fn(function* () {
        return [];
      }),
      reconcile: Effect.fn(function* ({ news }) {
        const ownerId = yield* Client.resolveOwnerId(news.ownerId);
        const token = unwrapOptionalSecret(news.token);
        const updated = yield* Client.putOwnerMetricsStream(ownerId, {
          provider: news.provider,
          url: news.url,
          ...(token !== undefined ? { token } : {}),
        });
        return {
          ownerId: updated.ownerId ?? ownerId,
          provider: updated.provider ?? news.provider,
          url: updated.url ?? news.url,
          token: toRedacted(news.token),
        };
      }),
      delete: Effect.fn(function* ({ output }) {
        if (!output?.ownerId) return;
        yield* Client.deleteOwnerMetricsStream(output.ownerId);
      }),
    }),
  );
