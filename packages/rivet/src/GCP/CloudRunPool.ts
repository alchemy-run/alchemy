import * as IAM from "@alchemy.run/gcp/IAM";
import * as Run from "@alchemy.run/gcp/Run";
import * as SecretManager from "@alchemy.run/gcp/SecretManager";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
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
   * on each secret before the worker pool rolls out a revision that reads it,
   * and Cloud Run hands the values to the container, so they stay out of the
   * worker pool's configuration. The control plane's token reaches the
   * nodes this way too, from a secret the pool keeps; name `RIVET_TOKEN`
   * here to use a secret of your own instead.
   */
  secrets?: Record<string, Input<string>>;
  /**
   * Email of the service account the nodes run as. Alchemy grants it access
   * to `secrets` but never deletes it.
   * @default the worker pool's own
   */
  serviceAccount?: Input<string>;
  /**
   * VPC network the nodes send private traffic through, with Cloud Run
   * direct VPC egress, so they reach a control plane at a private address.
   * Traffic to public addresses still leaves directly. Cloud Run holds the
   * subnetwork's addresses for up to a few hours after the pool is deleted,
   * and the subnetwork can't be deleted until it lets them go: a destroy in
   * that window fails on the subnetwork, keeps it in state, and succeeds
   * when run again later.
   */
  network?: Input<string>;
  /**
   * Subnetwork of `network` the nodes take their addresses from.
   * @default the subnetwork named like `network`
   */
  subnetwork?: Input<string>;
}

const asOutput = (value: Input<string>): Output.Output<string> =>
  (Output.isOutput(value) ? value : Output.literal(value)) as Output.Output<string>;

/** `projects/p/secrets/s/versions/3` as Cloud Run's `{ secret, version }`. */
const secretKeyRef = (version: string) => {
  const at = version.lastIndexOf("/versions/");
  return { secret: version.slice(0, at), version: version.slice(at + "/versions/".length) };
};

/** The grants that let a pool's worker pool read the secrets it names. @internal */
export const secretGrants = (versions: readonly string[]) =>
  versions.map((version) => ({
    role: "roles/secretmanager.secretAccessor",
    resource: { kind: "secretmanager.secret" as const, name: secretKeyRef(version).secret },
  }));

/** A node's plain environment: every value not read from Secret Manager. @internal */
export const plainEnvironment = (
  env: Record<string, string>,
  secrets: Record<string, unknown> | undefined,
) =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !Object.hasOwn(secrets ?? {}, name)));

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
) => ({
  ...(identity.serviceAccount === undefined ? {} : { serviceAccount: identity.serviceAccount }),
  ...(options.network === undefined && options.subnetwork === undefined
    ? {}
    : {
        vpcAccess: {
          egress: "PRIVATE_RANGES_ONLY",
          networkInterfaces: [{ network: options.network, subnetwork: options.subnetwork }],
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
});

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
 * @primitive
 */
export const CloudRunPool = (id: string, options: CloudRunPoolOptions = {}) =>
  makePoolLayer({
    label: "RivetGCP.CloudRunPool",
    id,
    settings: options,
    expected: "a reachable control plane",
    // Worker pools reach the internet without a VPC of their own.
    network: (cluster) => cluster.network ?? { kind: "none" as const },
    nodes: (nodes) =>
      Effect.gen(function* () {
        const location =
          options.location ?? (nodes.network?.kind === "gcp" ? nodes.network.region : undefined);
        const { program } = nodes;
        // The control plane's token reaches the nodes from Secret Manager,
        // never the worker pool's config, unless the pool names its own.
        const token =
          options.secrets?.RIVET_TOKEN === undefined
            ? (yield* SecretManager.Secret(`${id}Token`, {
                value: nodes.environment.RIVET_TOKEN,
              })).version.pipe(Output.map((version) => version ?? ""))
            : undefined;
        const secretMap: Record<string, Input<string>> = {
          ...(token === undefined ? {} : { RIVET_TOKEN: token }),
          ...options.secrets,
        };
        const secrets = Object.entries(secretMap);
        const { serviceAccount } = options;
        const secretEnv: Array<Input<Run.WorkerPoolEnvVar>> = [];
        for (const [name, version] of secrets) {
          // Cloud Run checks a revision can read its secrets when it creates
          // it. An account of the user's own is granted each secret by the
          // pool's own grant, read once it exists; the worker pool's own
          // account is granted them by the worker pool, before it deploys.
          const ready =
            serviceAccount === undefined
              ? asOutput(version)
              : Output.all(
                  asOutput(version),
                  (yield* IAM.Member(`${id}Secret${name}`, {
                    kind: "secretmanager.secret",
                    name: asOutput(version).pipe(Output.map((v) => secretKeyRef(v).secret)),
                    role: "roles/secretmanager.secretAccessor",
                    member: Output.interpolate`serviceAccount:${asOutput(serviceAccount)}`,
                  })).role,
                ).pipe(Output.map(([v]) => v));
          secretEnv.push({
            name,
            valueSource: { secretKeyRef: ready.pipe(Output.map(secretKeyRef)) },
          });
        }
        const own = Output.all(
          ...Object.entries(options.env ?? {}).map(([name, value]) =>
            asOutput(value).pipe(Output.map((v) => [name, v] as const)),
          ),
        ).pipe(Output.map((entries) => Object.fromEntries(entries)));
        // Every class the pool hosts is bundled into its node image; a Rust
        // program is its own image, built from its staged crate.
        const workerPool = yield* Run.WorkerPool(`${id}Nodes`, {
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
          template: nodeTemplate(options, { serviceAccount, secretEnv }),
          env: Output.all(nodeEnvironment(nodes), own).pipe(
            Output.map(([env, extra]) => plainEnvironment({ ...env, ...extra }, secretMap)),
          ),
        });
        if (serviceAccount === undefined && secrets.length > 0) {
          // The worker pool keeps its own account and owns these grants:
          // it revokes them with the binding and deletes them with itself.
          yield* workerPool.bind`RivetGCP.CloudRunPool.secrets(${id})`(
            Output.all(...secrets.map(([, version]) => asOutput(version))).pipe(
              Output.map((versions) => ({ iam: secretGrants(versions) })),
            ),
          );
        }
      }),
  });
