import * as DO from "@distilled.cloud/digitalocean";
import type { DestinationOmitCredentials } from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import type { Providers } from "../Providers.ts";

export type DestinationProps = {
  /**
   * Destination name. A change replaces the destination.
   *
   * @default a generated physical name
   */
  name?: string;
  /**
   * Where logs go: a DigitalOcean Managed OpenSearch cluster (by id, signed
   * with its own credentials), or any OpenSearch endpoint with a username and
   * password. A change replaces the destination.
   */
  opensearch:
    | { clusterId: string; indexName?: string; retentionDays?: number }
    | {
        endpoint: string;
        username: string;
        password: string | Redacted.Redacted<string>;
        indexName?: string;
        retentionDays?: number;
      };
};

export type Destination = Resource<
  "DigitalOcean.Monitoring.Destination",
  DestinationProps,
  {
    /** Destination id; pass it to a `Monitoring.Sink`. */
    destinationId: string;
    /** Destination name. */
    name: string;
    /** `OPENSEARCH_DBAAS` or `OPENSEARCH_EXT`. */
    type: string;
  },
  never,
  Providers
>;

export type DestinationAttributes = Destination["Attributes"];

/**
 * A log-forwarding destination: an OpenSearch index that Kubernetes log
 * sinks forward to. Any change replaces the destination: the API's update
 * endpoint answers `405` to the request its spec documents.
 *
 * ### Forwarding Logs to OpenSearch
 * **Example:** A managed OpenSearch cluster
 * ```typescript
 * const search = yield* DigitalOcean.Databases.Cluster("logs", {
 *   engine: "opensearch",
 *   size: "db-s-1vcpu-2gb",
 *   region: "nyc3",
 * });
 * const logs = yield* DigitalOcean.Monitoring.Destination("logs", {
 *   opensearch: { clusterId: search.clusterId, indexName: "app-logs", retentionDays: 14 },
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/products/kubernetes/how-to/forward-logs/
 *
 * @resource
 * @product Monitoring
 * @category Observability
 */
export const Destination = Resource<Destination>("DigitalOcean.Monitoring.Destination");

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

const kindOf = (props: DestinationProps) =>
  "clusterId" in props.opensearch ? "opensearch_dbaas" : "opensearch_ext";

const configOf = (props: DestinationProps) => {
  const o = props.opensearch;
  return "clusterId" in o
    ? {
        endpoint: "",
        cluster_uuid: o.clusterId,
        index_name: o.indexName,
        retention_days: o.retentionDays,
      }
    : {
        endpoint: o.endpoint,
        credentials: {
          username: o.username,
          password: typeof o.password === "string" ? o.password : Redacted.value(o.password),
        },
        index_name: o.indexName,
        retention_days: o.retentionDays,
      };
};

const toAttrs = (destination: DestinationOmitCredentials): DestinationAttributes => ({
  destinationId: destination.id,
  name: destination.name,
  type: destination.type,
});

const observe = (id: string) =>
  noneIfNotFound(
    DO.getMonitoringDestination({ destination_uuid: id }).pipe(Effect.map((r) => r.destination)),
  );

export const DestinationProvider = () =>
  Provider.succeed(Destination, {
    stables: ["destinationId", "type"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const observed = yield* observe(output.destinationId);
      return Option.getOrUndefined(Option.map(observed, toAttrs));
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (
        news.name !== olds.name ||
        JSON.stringify(configOf(news)) !== JSON.stringify(configOf(olds))
      ) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      if (output !== undefined) {
        const observed = yield* observe(output.destinationId);
        if (Option.isSome(observed)) return toAttrs(observed.value);
      }
      const name = news.name ?? (yield* physicalName(id));
      const { destination } = yield* DO.createMonitoringDestination({
        name,
        type: kindOf(news),
        config: configOf(news),
      });
      return toAttrs(destination);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        DO.deleteMonitoringDestination({ destination_uuid: output.destinationId }),
      );
    }),
  });
