import * as IAM from "@alchemy.run/gcp/IAM";
import * as Run from "@alchemy.run/gcp/Run";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import type { ClusterNetwork, ClusterShape } from "../Cluster.ts";
import {
  isImageProgram,
  makePoolLayer,
  nodeDockerfile,
  nodeEnvironment,
  RIVETKIT_VERSION,
  type PoolSettings,
} from "../internal/PoolHost.ts";

export interface CloudRunPoolOptions extends PoolSettings {
  /**
   * Number of nodes.
   * @default 1
   */
  replicas?: number;
  /**
   * Region of the worker pool.
   * @default the control plane's region, or the stack's
   */
  location?: string;
  /**
   * CPU of each node (Cloud Run quantity, e.g. `"1"`).
   * @default "1"
   */
  cpu?: string;
  /**
   * Memory of each node (e.g. `"1Gi"`).
   * @default "1Gi"
   */
  memory?: string;
  /**
   * Environment each node runs with, besides the pool's own. A value named
   * here wins over the pool's own, so `RIVET_ENDPOINT` points the nodes at
   * a private address of the control plane, and `RIVET_NODE_VERSION` tells
   * the control plane which nodes are newer (see `drainOnVersionUpgrade`).
   */
  env?: Record<string, Input<string>>;
  /**
   * Environment each node reads from Secret Manager, by the secret version
   * each value names, such as `projects/acme/secrets/DATABASE_URL/versions/3`.
   * The nodes' service account is granted `roles/secretmanager.secretAccessor`
   * on each secret, and Cloud Run hands the values to the container, so they
   * stay out of the worker pool's configuration.
   * Name `RIVET_TOKEN` here to keep the control plane's token out of it too.
   */
  secrets?: Record<string, Input<string>>;
  /**
   * Email of the service account the nodes run as.
   * @default the worker pool's own, or, with `secrets`, a service account of the pool's own
   */
  serviceAccount?: Input<string>;
  /**
   * VPC network the nodes send private traffic through, with Cloud Run
   * direct VPC egress, so they reach a control plane at a private address.
   * Traffic to public addresses still leaves directly. Cloud Run holds the
   * subnetwork's addresses for a while after the pool is deleted.
   */
  network?: Input<string>;
  /**
   * Subnetwork of `network` the nodes take their addresses from.
   * @default the subnetwork named like `network`
   */
  subnetwork?: Input<string>;
  /**
   * Send the nodes' private traffic through the control plane's GCP network
   * (a `Rivet.ControlPlane` given `network` of kind `gcp`), so they reach
   * its `nodeEndpoint`. `network` and `subnetwork` set here win over its own.
   * A cluster on no GCP network fails the deploy.
   * @default false
   */
  clusterNetwork?: boolean;
  /**
   * RivetKit release the nodes run a TypeScript program with. Nodes speak
   * the control plane protocol of their release: a 3.0 node works with a
   * 3.0 or 3.1 control plane, a 3.1 node needs a 3.1 one.
   * @default "3.0.0"
   */
  rivetkitVersion?: string;
}

const asOutput = (value: Input<string>): Output.Output<string> =>
  (Output.isOutput(value) ? value : Output.literal(value)) as Output.Output<string>;

/** `projects/p/secrets/s/versions/3` as Cloud Run's `{ secret, version }`. */
const secretKeyRef = (version: string) => {
  const at = version.lastIndexOf("/versions/");
  return { secret: version.slice(0, at), version: version.slice(at + "/versions/".length) };
};

/**
 * The revision template of a pool's worker pool, its secrets given as
 * container env. With no options set it is the template every pool had
 * before these options existed. @internal
 */
export const nodeTemplate = (
  options: CloudRunPoolOptions,
  identity: {
    readonly serviceAccount?: Input<string>;
    readonly secretEnv?: Array<Input<Run.WorkerPoolEnvVar>>;
  } = {},
  cluster?: ClusterNetwork | { readonly kind: "none" },
) => {
  // With `clusterNetwork`, the control plane's network and subnetwork fill
  // in what the pool doesn't name; a pool that names its own network takes
  // none of the control plane's.
  const joined = options.clusterNetwork === true && cluster?.kind === "gcp" ? cluster : undefined;
  const network = options.network ?? joined?.network;
  const subnetwork =
    options.subnetwork ?? (options.network === undefined ? joined?.subnetwork : undefined);
  return {
    ...(identity.serviceAccount === undefined ? {} : { serviceAccount: identity.serviceAccount }),
    ...(network === undefined && subnetwork === undefined
      ? {}
      : {
          vpcAccess: {
            egress: "PRIVATE_RANGES_ONLY",
            networkInterfaces: [{ network, subnetwork }],
          },
        }),
    containers: [
      {
        resources: {
          limits: { cpu: options.cpu ?? "1", memory: options.memory ?? "1Gi" },
        },
        ...(identity.secretEnv === undefined || identity.secretEnv.length === 0
          ? {}
          : { env: identity.secretEnv }),
      },
    ],
  };
};

/**
 * The network a pool's nodes are on, as `makePoolLayer` compares it with
 * the cluster's: only the cluster's own network gets its `nodeEndpoint`.
 * Worker pools reach the internet without a VPC of their own, so a pool
 * that doesn't join a GCP control plane's network gets a copy of it, which
 * still gives the region, and its nodes connect to the public endpoint.
 * @internal
 */
export const nodesNetwork = (
  options: Pick<CloudRunPoolOptions, "clusterNetwork">,
  cluster: Pick<ClusterShape, "network">,
) => {
  if (options.clusterNetwork) return cluster.network?.kind === "gcp" ? cluster.network : undefined;
  if (cluster.network?.kind === "gcp") return { ...cluster.network };
  return cluster.network ?? { kind: "none" as const };
};

/**
 * Run a pool's nodes on a Cloud Run worker pool: a pool on the control
 * plane, and a worker pool whose instances host every `Rivet.DurableObject`
 * given this pool. Worker pools serve no requests and keep a fixed number
 * of instances running, which is what a node is: it only connects out to
 * the control plane. Works with any control plane it can reach —
 * `RivetGCP.ComputeEngineControlPlane`, `RivetCloud.ControlPlane`, or one on
 * another cloud.
 *
 * Every Durable Object given the same pool shares its nodes: declare the
 * pool once and provide it to each class.
 *
 * A deploy that changes the nodes rolls out a new worker pool revision.
 * To move actors off the old nodes before Cloud Run stops them, give each
 * deploy a higher `RIVET_NODE_VERSION` and set `drainOnVersionUpgrade`.
 *
 * ### Running Durable Objects on Cloud Run
 * **Example:** Two nodes
 * ```typescript
 * export const Cluster = RivetGCP.ComputeEngineControlPlane("Rivet");
 * export const Default = RivetGCP.CloudRunPool("Default", { replicas: 2 }).pipe(
 *   Layer.provide(Cluster),
 * );
 * ```
 *
 * **Example:** Secrets, a private network, and draining on deploy
 * ```typescript
 * export const Default = RivetGCP.CloudRunPool("Default", {
 *   replicas: 2,
 *   serviceAccount: "nodes@acme.iam.gserviceaccount.com",
 *   network: "private",
 *   subnetwork: "private-us-central1",
 *   env: { RIVET_ENDPOINT: "http://10.0.0.2:6420", RIVET_NODE_VERSION: "42" },
 *   secrets: {
 *     RIVET_TOKEN: "projects/acme/secrets/rivet-token/versions/1",
 *     DATABASE_URL: "projects/acme/secrets/database-url/versions/3",
 *   },
 *   drainOnVersionUpgrade: true,
 *   actorEvictionPeriod: 60,
 * }).pipe(Layer.provide(Cluster));
 * ```
 *
 * **Example:** Nodes on the network of a control plane with a private address
 * ```typescript
 * export const Cluster = Rivet.ControlPlane("Rivet", {
 *   endpoint: "https://rivet.example.com",
 *   token: Config.Redacted("RIVET_TOKEN"),
 *   nodeEndpoint: "http://10.0.0.2:6420",
 *   network: {
 *     kind: "gcp",
 *     network: "rivet",
 *     subnetwork: "rivet-us-central1",
 *     region: "us-central1",
 *   },
 * });
 * export const Default = RivetGCP.CloudRunPool("Default", { clusterNetwork: true }).pipe(
 *   Layer.provide(Cluster),
 * );
 * ```
 *
 * @primitive
 */
export const CloudRunPool = (id: string, options: CloudRunPoolOptions = {}) =>
  makePoolLayer({
    label: "RivetGCP.CloudRunPool",
    id,
    settings: options,
    expected: options.clusterNetwork
      ? "the control plane's GCP network"
      : "a reachable control plane",
    network: (cluster) => nodesNetwork(options, cluster),
    nodes: (nodes) =>
      Effect.gen(function* () {
        const location =
          options.location ?? (nodes.network?.kind === "gcp" ? nodes.network.region : undefined);
        const { program } = nodes;
        const secrets = Object.entries(options.secrets ?? {});
        let serviceAccount = options.serviceAccount;
        const secretEnv: Array<Input<Run.WorkerPoolEnvVar>> = [];
        if (secrets.length > 0) {
          // Cloud Run checks a revision can read its secrets when it creates
          // it, so the nodes need an account, granted each secret, beforehand.
          serviceAccount ??= (yield* IAM.ServiceAccount(`${id}NodeAccount`, {
            displayName: "Rivet pool nodes",
          })).email;
          const member = Output.interpolate`serviceAccount:${asOutput(serviceAccount)}`;
          for (const [name, version] of secrets) {
            const grant = yield* IAM.Member(`${id}Secret${name}`, {
              kind: "secretmanager.secret",
              name: asOutput(version).pipe(Output.map((v) => secretKeyRef(v).secret)),
              role: "roles/secretmanager.secretAccessor",
              member,
            });
            secretEnv.push({
              name,
              valueSource: {
                // Read once the grant exists.
                secretKeyRef: Output.all(asOutput(version), grant.role).pipe(
                  Output.map(([v]) => secretKeyRef(v)),
                ),
              },
            });
          }
        }
        const own = Output.all(
          ...Object.entries(options.env ?? {}).map(([name, value]) =>
            asOutput(value).pipe(Output.map((v) => [name, v] as const)),
          ),
        ).pipe(Output.map((entries) => Object.fromEntries(entries)));
        // Every class the pool hosts is bundled into its node image; a Rust
        // program is its own image, built from its staged crate.
        yield* Run.WorkerPool(`${id}Nodes`, {
          ...(isImageProgram(program)
            ? program
            : {
                ...program,
                dockerfile: {
                  content: nodeDockerfile(options.rivetkitVersion ?? RIVETKIT_VERSION),
                },
              }),
          ...(location === undefined ? {} : { location }),
          scaling: { manualInstanceCount: options.replicas ?? 1 },
          template: nodeTemplate(options, { serviceAccount, secretEnv }, nodes.network),
          env: Output.all(nodeEnvironment(nodes), own).pipe(
            Output.map(([env, extra]) =>
              Object.fromEntries(
                Object.entries({ ...env, ...extra }).filter(
                  // A secret reaches the node from Secret Manager, never the env.
                  ([name]) => !secrets.some(([secret]) => secret === name),
                ),
              ),
            ),
          ),
        });
      }),
  });
