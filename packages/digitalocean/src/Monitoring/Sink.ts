import * as DO from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import type { Providers } from "../Providers.ts";

export type SinkProps = {
  /** The `Monitoring.Destination` logs are forwarded to. A change replaces the sink. */
  destinationId: string;
  /**
   * Resources whose logs are forwarded, by URN (a Kubernetes cluster's
   * `urn`, `do:kubernetes:<id>`). A change replaces the sink.
   */
  resources: { urn: string; name?: string }[];
};

export type Sink = Resource<
  "DigitalOcean.Monitoring.Sink",
  SinkProps,
  {
    /** Sink id. */
    sinkId: string;
    /** The destination. */
    destinationId: string;
  },
  never,
  Providers
>;

export type SinkAttributes = Sink["Attributes"];

/**
 * Forwards a Kubernetes cluster's logs to a `Monitoring.Destination`
 * (an OpenSearch index). Sinks have no update; a change replaces the sink.
 *
 * ### Forwarding Cluster Logs
 * **Example:** A cluster's logs to OpenSearch
 * ```typescript
 * const logs = yield* DigitalOcean.Monitoring.Destination("logs", {
 *   opensearch: { clusterId: search.clusterId, indexName: "k8s" },
 * });
 * yield* DigitalOcean.Monitoring.Sink("k8s-logs", {
 *   destinationId: logs.destinationId,
 *   resources: [{ urn: cluster.urn, name: "k8s" }],
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/products/kubernetes/how-to/forward-logs/
 *
 * @resource
 * @product Monitoring
 * @category Observability
 */
export const Sink = Resource<Sink>("DigitalOcean.Monitoring.Sink");

const observe = (sinkId: string) =>
  noneIfNotFound(DO.getMonitoringSink({ sink_uuid: sinkId }).pipe(Effect.map((r) => r.sink)));

export const SinkProvider = () =>
  Provider.succeed(Sink, {
    stables: ["sinkId", "destinationId"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const observed = yield* observe(output.sinkId);
      return Option.isSome(observed) ? output : undefined;
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (
        news.destinationId !== olds.destinationId ||
        JSON.stringify(news.resources) !== JSON.stringify(olds.resources)
      ) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      if (output !== undefined && Option.isSome(yield* observe(output.sinkId))) return output;
      const created = yield* DO.createMonitoringSink({
        destination_uuid: news.destinationId,
        resources: news.resources.map((r) => ({ urn: r.urn, name: r.name })),
      });
      return { sinkId: created.uuid, destinationId: news.destinationId };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteMonitoringSink({ sink_uuid: output.sinkId }));
    }),
  });
