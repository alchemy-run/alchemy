import {
  ClusterAdapter,
  ClusterNotFoundError,
  type ClusterAdapterService,
  type ClusterTransport,
} from "@alchemy.run/kubernetes/ClusterAdapter";
import type { Connection } from "@alchemy.run/kubernetes/Connection";
/**
 * The `digitalocean-doks` {@link ClusterAdapter}: connects the
 * cluster-agnostic `Kubernetes.*` workloads to a DigitalOcean Kubernetes
 * cluster.
 *
 * - **connect** — reads the cluster's endpoint and CA, and authenticates
 *   with a short-lived bearer token from the DigitalOcean credentials API,
 *   minted with the deploy's DigitalOcean token and renewed before it
 *   expires.
 *
 * DigitalOcean has no workload identity, so the adapter provides no
 * `identity`; images for `main`/`context` workloads go to the registry the
 * connection names.
 *
 * Registered by `DigitalOcean.providers()`; resolved by the `Kubernetes.*`
 * providers through the connection's `auth.kind`.
 */
import * as DO from "@distilled.cloud/digitalocean";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export class KubernetesCredentialsUnavailable extends Data.TaggedError(
  "DigitalOcean.Kubernetes.CredentialsUnavailable",
)<{
  readonly message: string;
}> {}

declare module "@alchemy.run/kubernetes/Connection" {
  interface AuthRegistry {
    /**
     * Authenticate against a DigitalOcean Kubernetes cluster with bearer
     * tokens minted from the DigitalOcean credentials. Contributed by
     * `DigitalOcean.providers()`; `DigitalOcean.Kubernetes.Cluster`
     * exposes a ready-made `connection`.
     */
    "digitalocean-doks": {
      /** DigitalOcean Kubernetes cluster id (UUID). */
      clusterId: string;
    };
  }
}

/** The `Kubernetes.Connection` for a DigitalOcean Kubernetes cluster. */
export const doksConnectionOf = (options: {
  clusterId: string;
  endpoint?: string | undefined;
}): Connection => ({
  endpoint: options.endpoint,
  auth: { kind: "digitalocean-doks", clusterId: options.clusterId },
});

// Tokens last a week by default; ask for an hour and renew early.
const TOKEN_LIFETIME_SECONDS = 3600;
const RENEW_BEFORE_MS = 5 * 60 * 1000;

export const DoksKubernetesAdapter = () =>
  Layer.effect(
    ClusterAdapter("digitalocean-doks"),
    Effect.gen(function* () {
      const context = yield* Effect.context<DO.DigitalOceanOpContext>();
      const withDigitalOcean = <A, E, R>(self: Effect.Effect<A, E, R>) =>
        Effect.provideContext(self, context);

      const connect: ClusterAdapterService["connect"] = (connection) =>
        Effect.gen(function* () {
          if (connection.auth.kind !== "digitalocean-doks") {
            return yield* Effect.die(
              new Error(`digitalocean-doks adapter received auth kind '${connection.auth.kind}'`),
            );
          }
          const { clusterId } = connection.auth;
          const cluster = yield* DO.getKubernetesCluster({ cluster_id: clusterId }).pipe(
            Effect.map((r) => r.kubernetes_cluster),
            Effect.catchTag("NotFound", () =>
              Effect.fail(
                new ClusterNotFoundError({
                  message: `DigitalOcean Kubernetes cluster '${clusterId}' no longer exists`,
                }),
              ),
            ),
          );
          if (cluster.status?.state === "deleted" || cluster.status?.state === "deleting") {
            return yield* new ClusterNotFoundError({
              message: `DigitalOcean Kubernetes cluster '${clusterId}' is being deleted`,
            });
          }
          const mint = DO.getKubernetesCredentials({
            cluster_id: clusterId,
            expiry_seconds: TOKEN_LIFETIME_SECONDS,
          });
          const first = yield* mint;
          if (!first.server || !first.certificate_authority_data) {
            return yield* new KubernetesCredentialsUnavailable({
              message: `DigitalOcean Kubernetes cluster '${clusterId}' has no endpoint yet (still provisioning?)`,
            });
          }
          let current = first;
          const fresh = Effect.suspend(() => {
            const expiresAt = Date.parse(current.expires_at ?? "");
            return Number.isFinite(expiresAt) && expiresAt - Date.now() > RENEW_BEFORE_MS
              ? Effect.succeed(current)
              : Effect.tap(mint, (next) => Effect.sync(() => (current = next)));
          });
          return {
            endpoint: first.server,
            certificateAuthorityData: first.certificate_authority_data,
            headers: fresh.pipe(
              Effect.flatMap((creds) =>
                creds.token === undefined
                  ? Effect.fail(
                      new KubernetesCredentialsUnavailable({
                        message: `DigitalOcean returned no token for cluster '${clusterId}'`,
                      }),
                    )
                  : Effect.succeed({
                      Authorization: `Bearer ${
                        typeof creds.token === "string" ? creds.token : Redacted.value(creds.token)
                      }`,
                    }),
              ),
              withDigitalOcean,
            ),
          } satisfies ClusterTransport;
        }).pipe(withDigitalOcean);

      return {
        kind: "Kubernetes.ClusterAdapter",
        connect,
      } satisfies ClusterAdapterService;
    }),
  );
