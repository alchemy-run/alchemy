import {
  ClusterAdapter,
  ClusterNotFoundError,
  type ClusterAdapterService,
  type ClusterTransport,
} from "@alchemy.run/kubernetes/ClusterAdapter";
import type { Connection } from "@alchemy.run/kubernetes/Connection";
import type { Credentials } from "@distilled.cloud/stackit/Credentials";
import * as ske from "@distilled.cloud/stackit/ske";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as YAML from "yaml";
import { StackitEnvironment } from "../Environment.ts";
import {
  clusterState,
  getClusterOrUndefined,
  isCredentialRevoked,
  mintedAtOf,
} from "./internal.ts";

/**
 * The lifetime of a connection's kubeconfig. It is admin access that can't be
 * revoked, and it lives only in memory, so an hour covers any deploy.
 */
const CONNECTION_TTL_SECONDS = 3600;

/**
 * A cached connection is re-minted this long before expiry, so a lifecycle
 * operation always starts with far more time than its longest wait (minutes).
 */
const CONNECTION_REFRESH_MS = 15 * 60 * 1000;

/** The cluster's API isn't available: it is starting or hibernated. */
export class KubernetesAdapterNotReady extends Data.TaggedError(
  "Stackit.SKE.KubernetesAdapterNotReady",
)<{
  readonly message: string;
}> {}

/** A call behind a connection failed, or its kubeconfig was unusable. */
export class KubernetesAdapterOperationFailed extends Data.TaggedError(
  "Stackit.SKE.KubernetesAdapterOperationFailed",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

declare module "@alchemy.run/kubernetes/Connection" {
  interface AuthRegistry {
    /**
     * Authenticate against an SKE cluster with a short-lived admin kubeconfig
     * minted from the ambient STACKIT credentials. Contributed by
     * `Stackit.providers()`; `Stackit.SKE.Cluster` attributes expose a ready-made
     * `connection` carrying this descriptor.
     */
    "stackit-ske": {
      /** Name of the cluster. */
      clusterName: string;
      /**
       * Project of the cluster.
       * @default the profile's project
       */
      projectId?: string;
      /**
       * Region of the cluster.
       * @default the profile's region
       */
      region?: string;
    };
  }
}

/** The parts of a kubeconfig that reach a cluster. */
export interface ParsedKubeconfig {
  /** API server URL. */
  readonly endpoint: string;
  /** Base64-encoded PEM certificate authority bundle. */
  readonly certificateAuthorityData: string | undefined;
  /** Whether the kubeconfig skips TLS verification. */
  readonly insecureSkipTlsVerify: boolean | undefined;
  /** Bearer token, when it authenticates with one. */
  readonly token: string | undefined;
  /** PEM client certificate, when it authenticates with one. */
  readonly clientCert: { readonly certificate: string; readonly key: string } | undefined;
}

interface KubeconfigFile {
  "current-context"?: string;
  clusters?: {
    name?: string;
    cluster?: {
      server?: string;
      "certificate-authority-data"?: string;
      "insecure-skip-tls-verify"?: boolean;
    };
  }[];
  users?: {
    name?: string;
    user?: {
      token?: string;
      "client-certificate-data"?: string;
      "client-key-data"?: string;
    };
  }[];
  contexts?: { name?: string; context?: { cluster?: string; user?: string } }[];
}

const decodeBase64 = (value: string) => Buffer.from(value, "base64").toString("utf8");

/**
 * Parse a kubeconfig holding inline credentials, as `CreateKubeconfig` returns.
 * `undefined` when it isn't one: not YAML, or with no server to connect to.
 * Never put its text in an error, because it holds credentials.
 */
export const parseKubeconfig = (text: string): ParsedKubeconfig | undefined => {
  let file: KubeconfigFile | null;
  try {
    file = YAML.parse(text) as KubeconfigFile | null;
  } catch {
    return undefined;
  }
  const context =
    file?.contexts?.find((entry) => entry.name === file?.["current-context"])?.context ??
    file?.contexts?.[0]?.context;
  const cluster = (
    file?.clusters?.find((entry) => entry.name === context?.cluster) ?? file?.clusters?.[0]
  )?.cluster;
  if (!cluster?.server) return undefined;
  const user = (file?.users?.find((entry) => entry.name === context?.user) ?? file?.users?.[0])
    ?.user;
  const certificate = user?.["client-certificate-data"];
  const key = user?.["client-key-data"];
  return {
    endpoint: cluster.server,
    certificateAuthorityData: cluster["certificate-authority-data"],
    insecureSkipTlsVerify: cluster["insecure-skip-tls-verify"],
    token: user?.token,
    clientCert:
      certificate !== undefined && key !== undefined
        ? { certificate: decodeBase64(certificate), key: decodeBase64(key) }
        : undefined,
  };
};

/** Services the adapter's methods close over at layer build. */
type SkeAdapterDeps = Credentials | HttpClient | StackitEnvironment;

const narrowSkeAuth = (connection: Connection) =>
  connection.auth.kind === "stackit-ske"
    ? Effect.succeed(connection.auth)
    : Effect.die(new Error(`stackit-ske adapter received auth kind '${connection.auth.kind}'`));

interface CachedConnection {
  readonly transport: ClusterTransport;
  readonly expiresAt: number;
  readonly mintedAt: string;
}

/**
 * Connect `Kubernetes.*` workloads to a STACKIT Kubernetes Engine cluster. This
 * is the `stackit-ske` cluster adapter, and `Stackit.providers()` includes it: you
 * never reference it directly. Pass a `Stackit.SKE.Cluster` as a workload's
 * `cluster`, and include `Kubernetes.providers()` next to `Stackit.providers()`.
 *
 * There is no SKE-specific runtime class. Workloads are the cluster-agnostic
 * `Kubernetes.Deployment`, `Kubernetes.Job`, `Kubernetes.Manifest` and
 * `Kubernetes.HelmChart`.
 *
 * ### Credentials and Expiry <!-- api-prose -->
 * SKE's API has no token endpoint. Each connection mints an admin kubeconfig with
 * a one-hour lifetime through `CreateKubeconfig` and reads the endpoint, the CA
 * and the credentials out of it. Nothing about it reaches state: the workload's
 * persisted `connection` holds only the cluster's name, project and region.
 *
 * The connection is cached in memory and re-minted when less than 15 minutes
 * remain, when the cluster has been recreated, or when a credentials rotation has
 * completed since it was minted. Since each deploy starts with no cache, a
 * kubeconfig that lapsed between deploys never gets in the way.
 *
 * A credential already minted can't be revoked, so a deploy leaves one behind
 * that stays valid for up to an hour. The deployer needs permission to mint them
 * (`ske.cluster.kubeconfig.create`). A hibernated cluster has to be woken first:
 * connecting to one fails with `KubernetesAdapterNotReady`.
 *
 * ### Identity <!-- api-prose -->
 * Pods run with no STACKIT identity of their own: the adapter doesn't provision
 * workload identity. A STACKIT binding on a workload takes the path it takes on
 * any foreign host, a `Stackit.IAM.ServiceAccount` and key bound into the
 * container's env. Whether STACKIT's federation accepts an SKE service account
 * issuer isn't documented, so this waits for a live proof.
 *
 * ### Images <!-- api-prose -->
 * The adapter has no managed registry yet. `main` and `context` workloads need a
 * `registry` on the cluster; `image` workloads don't. The deploying machine pushes
 * with `username` and `password`, or with its own `docker login` if you omit them.
 * Your nodes must be able to pull from it without credentials, or you must
 * provide an image pull secret with `podTemplate`.
 *
 * ### Running an Image
 * **Example:** A pre-built image behind a load balancer
 * ```typescript
 * import * as Kubernetes from "@alchemy.run/kubernetes";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Alchemy from "alchemy";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 *
 * export default Alchemy.Stack(
 *   "App",
 *   {
 *     providers: Layer.mergeAll(Stackit.providers(), Kubernetes.providers()),
 *     state: Alchemy.localState(),
 *   },
 *   Effect.gen(function* () {
 *     const cluster = yield* Stackit.SKE.Cluster("Cluster", {
 *       nodepools: [
 *         {
 *           name: "workers",
 *           machineType: "c1.2",
 *           availabilityZones: ["eu01-1"],
 *           minimum: 1,
 *           maximum: 3,
 *         },
 *       ],
 *     });
 *     const web = yield* Kubernetes.Deployment("Web", {
 *       cluster,
 *       image: "nginx:1.27",
 *       port: 80,
 *       replicas: 2,
 *     });
 *     return { url: web.url };
 *   }),
 * );
 * ```
 *
 * **Example:** Cluster-internal service
 * ```typescript
 * import * as Kubernetes from "@alchemy.run/kubernetes";
 *
 * const api = yield* Kubernetes.Deployment("Api", {
 *   cluster,
 *   image: "ghcr.io/acme/api:v3",
 *   port: 8080,
 *   serviceType: "ClusterIP",
 * });
 * ```
 *
 * ### Effect Workloads
 * **Example:** Effect HTTP server, built and pushed to your registry
 * ```typescript
 * import * as Kubernetes from "@alchemy.run/kubernetes";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * const cluster = yield* Stackit.SKE.Cluster("Cluster", {
 *   registry: { server: "ghcr.io/acme" },
 *   nodepools: [
 *     {
 *       name: "workers",
 *       machineType: "c1.2",
 *       availabilityZones: ["eu01-1"],
 *       minimum: 1,
 *       maximum: 3,
 *     },
 *   ],
 * });
 * const api = yield* Kubernetes.Deployment(
 *   "Api",
 *   { cluster, main: import.meta.url, port: 3000 },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("ok")),
 *     };
 *   }),
 * );
 * ```
 *
 * **Example:** Effect server bound to a STACKIT resource
 * ```typescript
 * import * as Kubernetes from "@alchemy.run/kubernetes";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * const zone = yield* Stackit.DNS.Zone("Zone", { dnsName: "example.com" });
 * const api = yield* Kubernetes.Deployment(
 *   "Api",
 *   { cluster, main: import.meta.url, port: 3000 },
 *   Effect.gen(function* () {
 *     const getZone = yield* Stackit.DNS.GetZone(zone);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { zone: live } = yield* getZone({});
 *         return yield* HttpServerResponse.json({ state: live.state });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.DNS.GetZoneHttp)),
 * );
 * ```
 *
 * **Example:** Effect program as a one-shot Job
 * ```typescript
 * import * as Kubernetes from "@alchemy.run/kubernetes";
 * import * as Effect from "effect/Effect";
 *
 * yield* Kubernetes.Job(
 *   "Migrate",
 *   { cluster, main: import.meta.url },
 *   Effect.gen(function* () {
 *     return { run: Effect.log("migrated") };
 *   }),
 * );
 * ```
 *
 * ### Async Workloads
 * **Example:** A plain server, with a typed `env`
 * ```typescript
 * // alchemy.run.ts
 * import * as Kubernetes from "@alchemy.run/kubernetes";
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * export const Api = Kubernetes.Deployment("Api", {
 *   cluster: Stackit.SKE.Cluster.ref("Cluster"),
 *   main: "./src/server.ts",
 *   port: 3000,
 *   env: { GREETING: "hello" },
 * });
 * export type ApiEnv = Stackit.InferEnv<typeof Api>;
 *
 * // src/server.ts
 * import type { ApiEnv } from "../alchemy.run.ts";
 *
 * const env = process.env as unknown as ApiEnv;
 *
 * Bun.serve({
 *   port: Number(process.env.PORT ?? 3000),
 *   fetch: () => new Response(env.GREETING),
 * });
 * ```
 *
 * ### Pushing Images
 * **Example:** Push to a STACKIT Container Registry project
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const images = yield* Stackit.ContainerRegistry.Project("Images", {});
 * const pusher = yield* Stackit.ContainerRegistry.RobotAccount("Pusher", {
 *   project: images.name,
 *   registryUrl: images.url,
 *   credentials: {
 *     username: "admin",
 *     secret: yield* Config.Redacted("HARBOR_CLI_SECRET"),
 *   },
 * });
 * const cluster = yield* Stackit.SKE.Cluster("Cluster", {
 *   registry: {
 *     server: images.imagePrefix,
 *     username: pusher.robotName,
 *     password: pusher.secret,
 *   },
 *   nodepools: [
 *     {
 *       name: "workers",
 *       machineType: "c1.2",
 *       availabilityZones: ["eu01-1"],
 *       minimum: 1,
 *       maximum: 3,
 *     },
 *   ],
 * });
 * ```
 *
 * ### Installing Software
 * **Example:** A Helm chart
 * ```typescript
 * import * as Kubernetes from "@alchemy.run/kubernetes";
 *
 * yield* Kubernetes.HelmChart("Ingress", {
 *   cluster,
 *   chart: "ingress-nginx",
 *   repo: "https://kubernetes.github.io/ingress-nginx",
 *   namespace: "ingress-nginx",
 *   createNamespace: true,
 * });
 * ```
 *
 * **Example:** Raw manifests
 * ```typescript
 * import * as Kubernetes from "@alchemy.run/kubernetes";
 *
 * yield* Kubernetes.Manifest("Namespace", {
 *   cluster,
 *   manifest: { apiVersion: "v1", kind: "Namespace", metadata: { name: "apps" } },
 * });
 * ```
 *
 * ### Reaching an Existing Cluster
 * **Example:** A cluster this stack doesn't manage
 * ```typescript
 * import * as Kubernetes from "@alchemy.run/kubernetes";
 *
 * const api = yield* Kubernetes.Deployment("Api", {
 *   cluster: { auth: { kind: "stackit-ske", clusterName: "prod" } },
 *   image: "ghcr.io/acme/api:v3",
 *   port: 8080,
 * });
 * ```
 *
 * @layer
 * @provides Kubernetes.ClusterAdapter/stackit-ske
 * @product STACKIT Kubernetes Engine
 * @category SKE
 */
export const SkeKubernetesAdapter = () =>
  Layer.effect(
    ClusterAdapter("stackit-ske"),
    Effect.gen(function* () {
      const context = yield* Effect.context<SkeAdapterDeps>();
      // Plain values, no finalizers. Credentials never leave this process.
      const connections = new Map<string, CachedConnection>();

      const connect: ClusterAdapterService["connect"] = (connection) =>
        Effect.gen(function* () {
          const auth = yield* narrowSkeAuth(connection);
          const env = yield* StackitEnvironment.current;
          const projectId = auth.projectId ?? env.projectId;
          const region = auth.region ?? env.region;
          const { clusterName } = auth;
          const key = `${projectId}/${region}/${clusterName}`;

          // Always read the cluster. A cached credential doesn't prove it still
          // exists, and delete uses ClusterNotFoundError to skip in-cluster objects.
          const cluster = yield* getClusterOrUndefined(projectId, region, clusterName);
          if (cluster === undefined) {
            connections.delete(key);
            return yield* new ClusterNotFoundError({
              message: `SKE cluster '${clusterName}' no longer exists`,
            });
          }
          const state = clusterState(cluster);
          if (
            state === "STATE_CREATING" ||
            state === "STATE_HIBERNATED" ||
            state === "STATE_HIBERNATING" ||
            state === "STATE_WAKINGUP"
          ) {
            return yield* new KubernetesAdapterNotReady({
              message: `SKE cluster '${clusterName}' has no reachable API while in ${state}`,
            });
          }

          const now = yield* Clock.currentTimeMillis;
          const cached = connections.get(key);
          if (
            cached !== undefined &&
            now < cached.expiresAt - CONNECTION_REFRESH_MS &&
            !isCredentialRevoked(cached.mintedAt, cluster)
          ) {
            return cached.transport;
          }

          const minted = yield* ske
            .createKubeconfig({
              projectId,
              region,
              clusterName,
              // `int64` is a string on the wire.
              expirationSeconds: String(CONNECTION_TTL_SECONDS),
            })
            .pipe(
              // A cluster going away can't serve a kubeconfig. Whether that surfaces
              // as a 400 isn't confirmed, so only a cluster known to be deleting
              // counts it as gone; elsewhere the failure stays a failure.
              Effect.catchTag("NotFound", () =>
                Effect.fail(
                  new ClusterNotFoundError({
                    message: `SKE cluster '${clusterName}' no longer exists`,
                  }),
                ),
              ),
              Effect.catchTag(
                "BadRequest",
                (error): Effect.Effect<never, ClusterNotFoundError | ske.BadRequest> =>
                  state === "STATE_DELETING"
                    ? Effect.fail(
                        new ClusterNotFoundError({
                          message: `SKE cluster '${clusterName}' is being deleted`,
                        }),
                      )
                    : Effect.fail(error),
              ),
            );

          const text =
            typeof minted.kubeconfig === "string"
              ? minted.kubeconfig
              : minted.kubeconfig === undefined
                ? undefined
                : Redacted.value(minted.kubeconfig);
          const parsed =
            text === undefined ? undefined : yield* Effect.sync(() => parseKubeconfig(text));
          if (
            parsed === undefined ||
            (parsed.token === undefined && parsed.clientCert === undefined)
          ) {
            return yield* new KubernetesAdapterOperationFailed({
              message:
                `The kubeconfig STACKIT minted for SKE cluster '${clusterName}' has ` +
                "no server or no inline credentials",
            });
          }

          const headers: Record<string, string> =
            parsed.token === undefined ? {} : { Authorization: `Bearer ${parsed.token}` };
          const transport: ClusterTransport = {
            endpoint: parsed.endpoint,
            certificateAuthorityData: parsed.certificateAuthorityData,
            insecureSkipTlsVerify: parsed.insecureSkipTlsVerify,
            headers: Effect.succeed(headers),
            clientCert:
              parsed.clientCert === undefined
                ? undefined
                : {
                    certificate: parsed.clientCert.certificate,
                    key: parsed.clientCert.key,
                  },
          };
          const expiresAt =
            minted.expirationTimestamp === undefined
              ? now + CONNECTION_TTL_SECONDS * 1000
              : new Date(minted.expirationTimestamp).getTime();
          connections.set(key, {
            transport,
            expiresAt,
            mintedAt: mintedAtOf(new Date(expiresAt).toISOString(), CONNECTION_TTL_SECONDS),
          });
          return transport;
        }).pipe(
          Effect.provideContext(context),
          Effect.mapError((error): ClusterNotFoundError | Error =>
            error instanceof ClusterNotFoundError || error instanceof Error
              ? error
              : new KubernetesAdapterOperationFailed({
                  message: `Failed to connect to an SKE cluster: ${String(error)}`,
                  cause: error,
                }),
          ),
        );

      return {
        kind: "Kubernetes.ClusterAdapter" as const,
        connect,
      } satisfies ClusterAdapterService;
    }),
  );
