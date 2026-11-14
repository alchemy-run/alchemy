import * as Kubernetes from "@alchemy.run/kubernetes";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import { Random } from "alchemy/Random";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { clusterShardGroups, Database as ClusterDatabase } from "../Database.ts";
import { stackDnsLabel } from "../internal/Naming.ts";
import type { Providers } from "../Providers.ts";

export interface DatabaseProps {
  /** The cluster the database and runners run on. */
  cluster: Kubernetes.ClusterLike | Effect.Effect<Input<Kubernetes.ClusterLike>, never, any>;
  /**
   * Kubernetes namespace of the database and runners.
   * @default "default"
   */
  namespace?: string;
  /**
   * Postgres image.
   * @default "postgres:17-alpine"
   */
  image?: string;
}

/**
 * The database an Effect Cluster coordinates through, on Kubernetes, as a
 * `Cluster.Database` Layer: Postgres as a Deployment behind a ClusterIP
 * Service, on the cluster the runners run on. Nothing outside the cluster
 * reaches it.
 *
 * Its data lives in the pod, so it is meant for development and tests; for
 * a managed Postgres (RDS, Cloud SQL, Neon), pass its URL to
 * `Cluster.Database.fromUrl` and give the pool its cluster.
 *
 * ### Running the database on Kubernetes
 * **Example:** Postgres on a local kind cluster
 * ```typescript
 * export const Kind = Kubernetes.LocalCluster("Kind", { name: "cluster" });
 * export const Database = ClusterKubernetes.Database("Cluster", { cluster: Kind });
 * ```
 *
 * @primitive
 */
export const Database = (id: string, props: DatabaseProps) =>
  Layer.effect(
    ClusterDatabase,
    Effect.gen(function* () {
      if (globalThis.__ALCHEMY_RUNTIME__) {
        // Runners read their database from their own environment at runtime.
        return { url: Redacted.make(""), shardGroups: undefined as never };
      }
      const namespace = props.namespace ?? "default";
      const cluster = Effect.isEffect(props.cluster) ? yield* props.cluster : props.cluster;
      const name = yield* stackDnsLabel(`${id}-db`, 50);
      const password = yield* Random(`${id}Password`, { bytes: 24 }) as unknown as Effect.Effect<
        Random,
        never,
        Providers
      >;
      const db = yield* Kubernetes.Deployment(`${id}Postgres`, {
        cluster,
        name,
        namespace,
        image: props.image ?? "postgres:17-alpine",
        port: 5432,
        serviceType: "ClusterIP",
        env: password.text.pipe(
          Output.map((text) => ({
            POSTGRES_PASSWORD: Redacted.value(text),
            POSTGRES_DB: "cluster",
          })),
        ) as unknown as Record<string, string>,
      });
      return {
        // Ordered after the Deployment: runners connect once it exists.
        url: Output.all(db.deploymentName, password.text).pipe(
          Output.map(([, text]) =>
            Redacted.make(
              `postgres://postgres:${encodeURIComponent(text.pipe(Redacted.value))}@${name}.${namespace}.svc.cluster.local:5432/cluster`,
            ),
          ),
        ),
        network: { kind: "kubernetes" as const, cluster, namespace },
        shardGroups: yield* clusterShardGroups(id),
      };
    }),
  );
