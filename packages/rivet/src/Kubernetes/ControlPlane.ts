import * as Kubernetes from "@alchemy.run/kubernetes";
import { connectCluster, readObject } from "@alchemy.run/kubernetes/Client";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import { Random } from "alchemy/Random";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { Cluster } from "../Cluster.ts";
import { stackDnsLabel } from "../internal/PoolHost.ts";
import { Namespace } from "../Namespace.ts";

/** The engine release `RivetKubernetes.ControlPlane` runs by default. */
export const DEFAULT_ENGINE_IMAGE = "rivetdev/engine:3.0.0-preview.4";

const DATA_PATH = "/var/lib/rivet";
const API_PORT = 6420;
const PEER_PORT = 6421;

/**
 * Where the control plane keeps the durable copy of every actor's data. The
 * engine reaches it over HTTPS only.
 */
export type ObjectStorage =
  | {
      /** An S3 (or S3-compatible, e.g. R2) bucket. */
      readonly kind: "s3";
      readonly bucket: Input<string>;
      readonly region?: Input<string>;
      /** An HTTPS endpoint for an S3-compatible service. */
      readonly endpoint?: Input<string>;
      readonly accessKeyId?: Input<string>;
      readonly secretAccessKey?: Input<Redacted.Redacted<string>>;
      readonly prefix?: string;
    }
  | {
      /** A Google Cloud Storage bucket. */
      readonly kind: "gcs";
      readonly bucket: Input<string>;
      /** A service account key (JSON). Defaults to application default credentials. */
      readonly serviceAccountKey?: Input<Redacted.Redacted<string>>;
      readonly prefix?: string;
    };

/** How the control plane's API is reached from outside the cluster. */
export type ControlPlaneExposure =
  | {
      /** A cloud load balancer, whose address becomes the endpoint. */
      readonly type: "LoadBalancer";
      readonly annotations?: Record<string, string>;
    }
  | {
      /**
       * A fixed node port, reached at `endpoint` (e.g. a kind cluster's
       * port mapping, `http://localhost:16450`). Callers inside the cluster
       * use the cluster-internal address.
       */
      readonly type: "NodePort";
      readonly nodePort: number;
      readonly endpoint: string;
    }
  | {
      /** A cluster-internal Service, reached at `endpoint` through your own ingress. */
      readonly type: "ClusterIP";
      readonly endpoint: Input<string>;
    };

export interface ControlPlaneProps {
  /**
   * The cluster to run on: a cluster resource (`Kubernetes.LocalCluster`,
   * `AWS.EKS.Cluster`, …), a `Kubernetes.KubeConfig(...)`, or a connection.
   */
  cluster: Kubernetes.ClusterLike | Effect.Effect<Input<Kubernetes.ClusterLike>, never, any>;
  /**
   * Kubernetes namespace to run in. It must already exist.
   * @default "default"
   */
  namespace?: string;
  /**
   * Number of engines, one pod each. More than one needs
   * {@link objectStorage}.
   * @default 1
   */
  instances?: number;
  /**
   * Size of each engine's volume.
   * @default "10Gi"
   */
  diskSize?: string;
  /**
   * StorageClass of each engine's volume.
   * @default the cluster's default StorageClass
   */
  storageClassName?: string;
  /**
   * Durable storage for actor data. Required for more than one instance;
   * one instance keeps it on its own volume.
   */
  objectStorage?: ObjectStorage;
  /**
   * How the API is reached from outside the cluster.
   * @default { type: "LoadBalancer" }
   */
  expose?: ControlPlaneExposure;
  /**
   * Engine image.
   * @default "rivetdev/engine:3.0.0-preview.4"
   */
  image?: string;
  /**
   * Base name of the Kubernetes objects.
   * @default ${stack}-${stage}-${id}
   */
  name?: string;
}

/** More than one engine with nowhere to share data. */
export class ObjectStorageRequired extends Data.TaggedError(
  "RivetKubernetes.ObjectStorageRequired",
)<{
  readonly message: string;
}> {}

/** The control plane's load balancer never got an address. */
export class LoadBalancerNotReady extends Data.TaggedError("RivetKubernetes.LoadBalancerNotReady")<{
  readonly message: string;
}> {}

/** The engine environment for the chosen object storage. */
const storageEnvironment = (storage: ObjectStorage | undefined) => {
  if (storage === undefined) {
    return [
      {
        name: "RIVET__OBJECT_STORAGE__PRIMARY__FILE_SYSTEM__PATH",
        value: `${DATA_PATH}/objects`,
      },
    ];
  }
  const prefix = storage.prefix === undefined ? [] : [["PREFIX", storage.prefix] as const];
  const entries: ReadonlyArray<readonly [string, unknown]> =
    storage.kind === "s3"
      ? [
          ["BUCKET", storage.bucket],
          ["REGION", storage.region],
          ["ENDPOINT", storage.endpoint],
          ["ACCESS_KEY_ID", storage.accessKeyId],
          ["SECRET_ACCESS_KEY", storage.secretAccessKey],
          ...prefix,
        ]
      : [["BUCKET", storage.bucket], ["SERVICE_ACCOUNT_KEY", storage.serviceAccountKey], ...prefix];
  return entries
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({
      name: `RIVET__OBJECT_STORAGE__PRIMARY__${storage.kind.toUpperCase()}__${key}`,
      value,
    }));
};

/**
 * A Rivet control plane on Kubernetes, as a `Rivet.Cluster` Layer: a
 * StatefulSet of engines, each with a volume of its own, a Service for the
 * API, a headless Service for the engines' peer traffic, the admin token in
 * a Secret, and a namespace for the stage. Runs on any cluster — EKS, GKE,
 * AKS, a local kind cluster.
 *
 * One engine keeps actor data on its own volume. More need shared object
 * storage (`objectStorage`: S3, an S3-compatible service, or GCS) reached
 * over HTTPS. Pools of nodes on the same cluster — `RivetKubernetes.Pool` —
 * connect to the engines inside the cluster.
 *
 * ### Running a control plane on Kubernetes
 * **Example:** Three engines behind a load balancer, data in S3
 * ```typescript
 * export const Cluster = RivetKubernetes.ControlPlane("Rivet", {
 *   cluster: EksCluster,
 *   instances: 3,
 *   objectStorage: { kind: "s3", bucket: "my-rivet-data", region: "us-west-2" },
 * });
 * ```
 *
 * **Example:** One engine on a local kind cluster
 * ```typescript
 * export const Cluster = RivetKubernetes.ControlPlane("Rivet", {
 *   cluster: Kind,
 *   expose: { type: "NodePort", nodePort: 30642, endpoint: "http://localhost:16450" },
 * });
 * ```
 *
 * @primitive
 */
export const ControlPlane = (id: string, props: ControlPlaneProps) =>
  Layer.effect(
    Cluster,
    Effect.gen(function* () {
      if (globalThis.__ALCHEMY_RUNTIME__) {
        // Nodes and callers read their endpoint and token from their own
        // environment at runtime; the cluster is only consulted while deploying.
        return { endpoint: "", token: Redacted.make(""), namespace: "default" };
      }
      const instances = props.instances ?? 1;
      if (instances > 1 && props.objectStorage === undefined) {
        return yield* Effect.die(
          new ObjectStorageRequired({
            message: `RivetKubernetes.ControlPlane("${id}") runs ${instances} engines, which share actor data through objectStorage.`,
          }),
        );
      }
      const cluster = Effect.isEffect(props.cluster) ? yield* props.cluster : props.cluster;
      const k8sNamespace = props.namespace ?? "default";
      const name = props.name ?? (yield* stackDnsLabel(id, 40));
      const labels = { "app.kubernetes.io/name": name, "app.kubernetes.io/part-of": "rivet" };
      const expose = props.expose ?? { type: "LoadBalancer" as const };

      const token = yield* Random(`${id}AdminToken`, { bytes: 32 });
      const secret = yield* Kubernetes.Manifest(`${id}TokenSecret`, {
        cluster,
        manifest: {
          apiVersion: "v1",
          kind: "Secret",
          metadata: { name: `${name}-token`, namespace: k8sNamespace, labels },
          type: "Opaque",
          stringData: { token: token.text },
        },
      });
      const peers = yield* Kubernetes.Manifest(`${id}PeerService`, {
        cluster,
        manifest: {
          apiVersion: "v1",
          kind: "Service",
          metadata: { name: `${name}-peers`, namespace: k8sNamespace, labels },
          spec: {
            clusterIP: "None",
            selector: labels,
            ports: [{ name: "peer", port: PEER_PORT, targetPort: PEER_PORT }],
          },
        },
      });
      const engines = yield* Kubernetes.Manifest(`${id}Engines`, {
        cluster,
        manifest: {
          apiVersion: "apps/v1",
          kind: "StatefulSet",
          metadata: { name, namespace: k8sNamespace, labels },
          spec: {
            serviceName: peers.name,
            replicas: instances,
            // Engines need each other to agree on the cluster's config.
            podManagementPolicy: "Parallel",
            selector: { matchLabels: labels },
            template: {
              metadata: { labels },
              spec: {
                terminationGracePeriodSeconds: 120,
                containers: [
                  {
                    name: "engine",
                    image: props.image ?? DEFAULT_ENGINE_IMAGE,
                    ports: [
                      { name: "api", containerPort: API_PORT },
                      { name: "peer", containerPort: PEER_PORT },
                    ],
                    env: [
                      { name: "POD_IP", valueFrom: { fieldRef: { fieldPath: "status.podIP" } } },
                      {
                        name: "RIVET__AUTH__ADMIN_TOKEN",
                        valueFrom: { secretKeyRef: { name: secret.name, key: "token" } },
                      },
                      { name: "RIVET__STORAGE__LOG_DIRECTORY", value: DATA_PATH },
                      {
                        name: "RIVET__API_PEER__ADVERTISE_ADDRESS",
                        value: `$(POD_IP):${PEER_PORT}`,
                      },
                      { name: "RIVET__TELEMETRY__ENABLED", value: "false" },
                      ...storageEnvironment(props.objectStorage),
                    ],
                    volumeMounts: [{ name: "data", mountPath: DATA_PATH }],
                    readinessProbe: {
                      httpGet: { path: "/health", port: API_PORT },
                      periodSeconds: 5,
                    },
                  },
                ],
              },
            },
            volumeClaimTemplates: [
              {
                metadata: { name: "data" },
                spec: {
                  accessModes: ["ReadWriteOnce"],
                  ...(props.storageClassName === undefined
                    ? {}
                    : { storageClassName: props.storageClassName }),
                  resources: { requests: { storage: props.diskSize ?? "10Gi" } },
                },
              },
            ],
          },
        },
      });
      const api = yield* Kubernetes.Manifest(`${id}ApiService`, {
        cluster,
        manifest: {
          apiVersion: "v1",
          kind: "Service",
          metadata: {
            name,
            namespace: k8sNamespace,
            labels,
            ...(expose.type === "LoadBalancer" && expose.annotations !== undefined
              ? { annotations: expose.annotations }
              : {}),
          },
          spec: {
            type: expose.type,
            selector: labels,
            ports: [
              {
                name: "api",
                port: API_PORT,
                targetPort: API_PORT,
                ...(expose.type === "NodePort" ? { nodePort: expose.nodePort } : {}),
              },
            ],
          },
        },
      });

      const internal = `http://${name}.${k8sNamespace}.svc.cluster.local:${API_PORT}`;
      const external: Output.Output<string> =
        expose.type === "LoadBalancer"
          ? Output.all(api.connection, api.ref).pipe(
              Output.mapEffect(([connection, ref]) => loadBalancerEndpoint(connection, ref)),
            )
          : Output.isOutput(expose.endpoint)
            ? (expose.endpoint as Output.Output<string>)
            : Output.literal(expose.endpoint as string);

      const namespace = yield* Namespace(`${id}Namespace`, {
        // Created through the API the engines serve, once they are declared.
        endpoint: Output.all(external, engines.uid, api.uid).pipe(Output.map(([url]) => url)),
        token: token.text,
      });
      return {
        endpoint: external,
        nodeEndpoint: internal,
        // A node port's endpoint is the deploying machine's (a local cluster's
        // port mapping); callers in the cluster use the Service.
        clientEndpoint: expose.type === "NodePort" ? internal : external,
        network: { kind: "kubernetes", cluster, namespace: k8sNamespace },
        token: token.text,
        namespace: namespace.name,
      };
    }),
  );

/** Wait for a LoadBalancer Service's address, as the control plane's endpoint. */
const loadBalancerEndpoint = (connection: Kubernetes.Connection, ref: unknown) =>
  connectCluster(connection).pipe(
    Effect.flatMap((transport) =>
      readObject({ transport, object: ref as Parameters<typeof readObject>[0]["object"] }),
    ),
    Effect.flatMap((response) => {
      const ingress = (
        response as {
          status?: { loadBalancer?: { ingress?: { hostname?: string; ip?: string }[] } };
        }
      )?.status?.loadBalancer?.ingress?.[0];
      const host = ingress?.hostname ?? ingress?.ip;
      return host === undefined
        ? Effect.fail(new LoadBalancerNotReady({ message: "no address yet" }))
        : Effect.succeed(`http://${host}:${API_PORT}`);
    }),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 60 }),
    Effect.catch(() =>
      Effect.die(
        new LoadBalancerNotReady({
          message: "The Rivet control plane's LoadBalancer Service got no address in 5 minutes.",
        }),
      ),
    ),
  );
