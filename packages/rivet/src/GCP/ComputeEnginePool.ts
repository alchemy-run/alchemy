import { createHash } from "node:crypto";
import * as Compute from "@alchemy.run/gcp/Compute";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import * as IAM from "@alchemy.run/gcp/IAM";
import * as SecretManager from "@alchemy.run/gcp/SecretManager";
import * as Storage from "@alchemy.run/gcp/Storage";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { loadNodeImage, saveNodeImage } from "../internal/NodeImage.ts";
import {
  bundleNodes,
  isImageProgram,
  makePoolLayer,
  SECRET_ENV,
  splitNodeEnvironment,
  RIVETKIT_VERSION,
  type PoolSettings,
} from "../internal/PoolHost.ts";

/** Container-Optimized OS: Docker preinstalled, a read-only root. */
const COS_IMAGE = "projects/cos-cloud/global/images/family/cos-stable";
const NODE_IMAGE = "node:26-slim";
const APP_PATH = "/var/lib/rivet-node";
const HASH_KEY = "rivet-node-hash";
const ENV_KEY = "rivet-node-env";
const INDEX_KEY = "rivet-node-index";
const SECRETS_KEY = "rivet-node-secrets";
const ROLLOUT_KEY = "rivet-node-rollout";
const REPLICAS_KEY = "rivet-node-replicas";

export interface ComputeEnginePoolOptions extends PoolSettings {
  /**
   * Number of nodes, one instance each, spread across zones.
   * @default 1
   */
  replicas?: number;
  /**
   * Machine type of each node.
   * @default "e2-small"
   */
  machineType?: string;
  /**
   * Zones the nodes are spread across, in the stack's region.
   * @default the region's `-a`, `-b` and `-c` zones
   */
  zones?: string[];
  /**
   * IPv4 range of the pool's subnetwork, when its cluster is not on a GCP
   * network of its own.
   * @default "10.46.0.0/20"
   */
  cidrBlock?: string;
  /**
   * Seconds a node gets to stop when a deploy restarts it: Docker sends it
   * SIGTERM, and SIGKILL once this has passed.
   * @default 30
   */
  stopTimeout?: number;
  /**
   * Seconds a node waits for its turn when a deploy changes the nodes.
   * Node `i` restarts only once node `i - 1` has restarted on the new
   * program and the control plane lists every node of the pool connected
   * again. A node still waiting when this has passed keeps running its
   * current program, and so does every node after it: a program that
   * never connects stops the rollout at its first node.
   * @default 600
   */
  rolloutTimeout?: number;
  /**
   * Environment each node runs with, besides the pool's own.
   */
  env?: Record<string, Input<string>>;
  /**
   * Environment each node reads from Secret Manager when it starts, by the
   * secret version each value names, such as
   * `projects/acme/secrets/DATABASE_URL/versions/3`. The nodes' service
   * account is granted `roles/secretmanager.secretAccessor` on each secret,
   * and the values stay out of instance metadata and the node's env file.
   * Docker still keeps a container's environment in its configuration on
   * the VM's disk, so root on the VM can read them.
   * The control plane's token reaches the nodes this way too, from a
   * secret the pool keeps; name `RIVET_TOKEN` here to use a secret of your
   * own instead. A node that cannot read a secret keeps running what it ran
   * before.
   */
  secrets?: Record<string, Input<string>>;
  /**
   * Email of the service account the nodes run as.
   * @default a service account of the pool's own
   */
  serviceAccount?: Input<string>;
}

const asOutput = (value: Input<string>): Output.Output<string> =>
  (Output.isOutput(value) ? value : Output.literal(value)) as Output.Output<string>;

/**
 * Boot one node: fetch the node program from the bucket and run it in a
 * Node container with RivetKit installed beside it, inside the container:
 * Container-Optimized OS mounts the host's writable paths `noexec`, and
 * RivetKit loads a native addon. Then wait on the metadata server, and run
 * the current script again whenever the program, its env or the script
 * changes, so a deploy reaches running nodes without replacing them.
 */
/** Arm machine series (Axion and Ampere); every other series is x86. */
const platformOf = (machineType: string) =>
  /^(t2a|c4a|n4a)-/.test(machineType) ? ("linux/arm64" as const) : ("linux/amd64" as const);

/**
 * Fetch the node program from the bucket and make its image ready, while
 * the running node keeps serving: a slow download or load never widens the
 * gap between stopping the old container and starting the new one.
 */
const prepareProgram = (bucket: string, image: boolean) =>
  image
    ? // A Rust program is a whole image: load it, and run it as it is.
      `curl -sf -H "Authorization: Bearer $TOKEN" -o ${APP_PATH}/node.tar.next \\
    "https://storage.googleapis.com/storage/v1/b/${bucket}/o/node.tar?alt=media" \\
    && mv ${APP_PATH}/node.tar.next ${APP_PATH}/node.tar
  ${loadNodeImage(`${APP_PATH}/node.tar`)}`
    : `curl -sf -H "Authorization: Bearer $TOKEN" -o ${APP_PATH}/node.mjs.next \\
    "https://storage.googleapis.com/storage/v1/b/${bucket}/o/node.mjs?alt=media" \\
    && mv ${APP_PATH}/node.mjs.next ${APP_PATH}/node.mjs
  IMAGE=${NODE_IMAGE}
  docker pull -q "$IMAGE" >/dev/null || true`;

/** The `docker run` arguments after the image: how the container starts the node. */
const runCommand = (image: boolean, rivetkitVersion: string) =>
  image
    ? ""
    : ` \\
    sh -c 'cp /program/node.mjs . && npm install --no-save --no-fund --no-audit rivetkit@${rivetkitVersion} && exec node node.mjs'`;

/**
 * Read each secret version named in the instance's metadata into the
 * script's environment and add `-e NAME` to `SECRET_ARGS`, so Docker hands
 * the value to the container without writing it anywhere. Fails, and the
 * running node is left as it is, when a secret cannot be read.
 */
const readSecrets = `SECRET_ARGS=()
  while IFS='=' read -r NAME VERSION; do
    [ -n "$NAME" ] || continue
    BODY="$(curl -sf -H "Authorization: Bearer $TOKEN" "https://secretmanager.googleapis.com/v1/$VERSION:access")" || return 1
    VALUE="$(printf '%s' "$BODY" | tr -d '\\n' | sed -E 's/.*"data": *"([^"]*)".*/\\1/' | base64 -d)" || return 1
    export "$NAME=$VALUE"
    SECRET_ARGS+=(-e "$NAME")
  done <<< "$(curl -sf -H 'Metadata-Flavor: Google' "$MD/instance/attributes/${SECRETS_KEY}")"`;

/**
 * Rollout markers and readiness: `marker N` names the object node N
 * writes to the bucket once it runs this rollout's program, and
 * `ready_nodes` counts the pool's nodes the control plane lists as
 * connected and not stopping.
 */
const rolloutFunctions = (
  bucket: string,
) => `md() { curl -sf -H 'Metadata-Flavor: Google' "$MD/instance/attributes/$1"; }
env_value() { grep -m1 "^$1=" ${APP_PATH}/env.list | cut -d= -f2-; }
marker() { printf 'https://storage.googleapis.com/storage/v1/b/${bucket}/o/rollout%%2F%s%%2F%s' "$ROLLOUT" "$1"; }
ready_nodes() {
  curl -sf -H "Authorization: Bearer \${RIVET_TOKEN:-}" \\
    "$(env_value RIVET_ENDPOINT)/pools/$(env_value RIVET_POOL)/nodes?namespace=$(env_value RIVET_NAMESPACE)&limit=100" \\
    | grep -o '{[^{}]*}' | grep -E '"connected": *true' | grep -cE '"stopping": *false'
}
# Whether the control plane lists every node connected; any failure is a no.
pool_whole() {
  local count
  count="$(ready_nodes 2>/dev/null | tail -n 1)"
  [ "\${count:-0}" -ge "$REPLICAS" ] 2>/dev/null
}
# Wait until node \`$1\` has written its marker (none: no wait) and the pool
# is whole, or give up at the deadline.
await_turn() {
  until { [ -z "$1" ] || curl -sf -o /dev/null -H "Authorization: Bearer $TOKEN" "$(marker "$1")"; } \\
    && pool_whole; do
    if [ "$SECONDS" -ge "$DEADLINE" ]; then return 1; fi
    sleep 5
  done
}`;

/** The startup script every node runs, rendered for a pool. @internal */
export const startupScript = (options: {
  readonly bucket: string;
  readonly image: boolean;
  readonly stopTimeout: number;
  readonly rolloutTimeout: number;
  readonly rivetkitVersion?: string;
}) => `#!/bin/bash
set -uo pipefail
MD=http://metadata.google.internal/computeMetadata/v1
mkdir -p ${APP_PATH}
${rolloutFunctions(options.bucket)}
log() { echo "rivet-node: $*" > /dev/ttyS0 2>/dev/null || echo "rivet-node: $*"; }
start() {
  TOKEN="$(curl -sf -H 'Metadata-Flavor: Google' "$MD/instance/service-accounts/default/token" | sed -E 's/.*"access_token":"([^"]+)".*/\\1/')"
  ${readSecrets}
  ${prepareProgram(options.bucket, options.image)}
  md ${ENV_KEY} > ${APP_PATH}/env.list
  INDEX="$(md ${INDEX_KEY} || echo 0)"
  REPLICAS="$(md ${REPLICAS_KEY} || echo 1)"
  ROLLOUT="$(md ${ROLLOUT_KEY} || echo none)"
  DEADLINE=$((SECONDS + ${options.rolloutTimeout}))
  if docker inspect rivet-node >/dev/null 2>&1; then
    # A deploy: node i waits until node i-1 runs the new program and every
    # node is connected, so the pool restarts one node at a time and the
    # others keep serving while it does.
    PREVIOUS="$([ "$INDEX" -gt 0 ] && echo $((INDEX - 1)))"
    if ! await_turn "$PREVIOUS"; then
      log "rollout $ROLLOUT: node \${PREVIOUS:-0} did not come back within ${options.rolloutTimeout}s; keeping this node on its current program"
      return 1
    fi
    # SIGTERM first, so the node drains its actors; SIGKILL only after the grace.
    docker stop -t ${options.stopTimeout} rivet-node >/dev/null 2>&1 || true
    docker rm -f rivet-node >/dev/null 2>&1 || true
  fi
  # --init forwards SIGTERM to the node whatever its image runs as PID 1.
  docker run -d --name rivet-node --restart always --network host --init \\
    --stop-timeout ${options.stopTimeout} --env-file ${APP_PATH}/env.list \${SECRET_ARGS[@]+"\${SECRET_ARGS[@]}"}${
      options.image
        ? ""
        : ` \\
    -v ${APP_PATH}/node.mjs:/program/node.mjs:ro -w /app`
    } "$IMAGE"${runCommand(options.image, options.rivetkitVersion ?? RIVETKIT_VERSION)}
  # Once the pool is whole again, tell the next node it is its turn.
  if await_turn ""; then
    curl -sf -o /dev/null -X POST -H "Authorization: Bearer $TOKEN" --data-binary '' \\
      "https://storage.googleapis.com/upload/storage/v1/b/${options.bucket}/o?uploadType=media&name=rollout%2F$ROLLOUT%2F$INDEX" || true
  else
    log "rollout $ROLLOUT: the pool did not reconnect within ${options.rolloutTimeout}s"
  fi
}
etag() {
  curl -sf -H 'Metadata-Flavor: Google' -D - -o /dev/null "$MD/instance/attributes/?recursive=true$1" \\
    | grep -i '^etag:' | awk '{print $2}' | tr -d '\\r'
}
# Read the version before starting, so a change made while this node
# waits its turn or starts still reaches it.
ETAG="$(etag "")"
start
# On any change, run the current startup script again: it starts the node
# afresh and waits for the next change, so a new script reaches this node too.
(
  while true; do
    NEXT="$(etag "&wait_for_change=true&timeout_sec=3600&last_etag=$ETAG")"
    if [ -n "$NEXT" ] && [ "$NEXT" != "$ETAG" ]; then
      curl -sf -H 'Metadata-Flavor: Google' "$MD/instance/attributes/startup-script" > ${APP_PATH}/startup.sh \\
        && exec setsid bash ${APP_PATH}/startup.sh
    fi
    sleep 5
  done
) >/dev/null 2>&1 < /dev/null &
# The node's logs on the serial console (\`gcloud compute instances get-serial-port-output\`).
pgrep -f "docker logs -f rivet-node" >/dev/null || setsid sh -c 'while true; do docker logs -f rivet-node 2>&1 | sed -u "s/^/rivet-node: /"; sleep 2; done > /dev/ttyS0' >/dev/null 2>&1 < /dev/null &
`;

/**
 * Run a pool's nodes on Compute Engine: a pool on the control plane, and
 * Container-Optimized OS instances across zones that each run every
 * `Rivet.DurableObject` given this pool in a Node container. The node
 * program sits in a Cloud Storage bucket the instances read as their own
 * service account; a deploy that changes it, or the nodes' env, restarts the
 * container on each instance in place, one node at a time: a node restarts
 * once the one before it runs the new program and the control plane lists
 * every node connected, and gets `stopTimeout` seconds to stop.
 *
 * Nodes only connect out to the control plane, so no inbound traffic
 * reaches them, and the pool works with any control plane it can reach —
 * `RivetGCP.ComputeEngineControlPlane`, `RivetCloud.ControlPlane`, or one on
 * another cloud. On a `RivetGCP.ComputeEngineControlPlane` the nodes join its
 * network.
 *
 * ### Running Durable Objects on Compute Engine
 * **Example:** Two nodes
 * ```typescript
 * export const Cluster = RivetGCP.ComputeEngineControlPlane("Rivet");
 * export const Default = RivetGCP.ComputeEnginePool("Default", { replicas: 2 }).pipe(
 *   Layer.provide(Cluster),
 * );
 * ```
 *
 * @primitive
 */
export const ComputeEnginePool = (id: string, options: ComputeEnginePoolOptions = {}) =>
  makePoolLayer({
    label: "RivetGCP.ComputeEnginePool",
    id,
    settings: options,
    expected: "a reachable control plane",
    network: (cluster) =>
      cluster.network?.kind === "gcp" ? cluster.network : { kind: "none" as const },
    nodes: Effect.fn(function* (nodes) {
      const region = yield* GcpEnvironment.current.pipe(
        Effect.map((env) => env.region),
        Effect.orDie,
      );
      const zones = options.zones ?? [`${region}-a`, `${region}-b`, `${region}-c`];

      // The pool joins its control plane's network, or brings its own.
      let network: Input<string>;
      let subnetwork: Input<string>;
      if (nodes.network.kind === "gcp") {
        network = nodes.network.network;
        subnetwork = nodes.network.subnetwork;
      } else {
        const own = yield* Compute.Network(`${id}Network`, { autoCreateSubnetworks: false });
        const subnet = yield* Compute.Subnetwork(`${id}Subnet`, {
          network: own.networkName,
          region,
          ipCidrRange: options.cidrBlock ?? "10.46.0.0/20",
        });
        network = own.networkName;
        subnetwork = subnet.subnetworkName;
      }

      const machineType = options.machineType ?? "e2-small";
      const image = isImageProgram(nodes.program);
      // A Rust program is its own image, saved for the VM to load.
      const file = isImageProgram(nodes.program)
        ? yield* saveNodeImage("gcp", id, nodes.program, platformOf(machineType))
        : yield* bundleNodes("gcp", id, nodes.program);
      const bucket = yield* Storage.Bucket(`${id}Program`, {
        location: region,
        forceDestroy: true,
        uniformBucketLevelAccess: true,
      });
      const program = yield* Storage.Object(`${id}ProgramObject`, {
        bucketName: bucket.bucketName,
        key: image ? "node.tar" : "node.mjs",
        file: file as unknown as string,
        contentType: image ? "application/x-tar" : "text/javascript",
      });

      const email =
        options.serviceAccount ??
        (yield* IAM.ServiceAccount(`${id}NodeAccount`, {
          displayName: "Rivet pool nodes",
        })).email;
      const member = Output.interpolate`serviceAccount:${asOutput(email)}`;
      const grant = yield* IAM.Member(`${id}ProgramGrant`, {
        kind: "storage.bucket",
        name: bucket.bucketName,
        role: "roles/storage.objectViewer",
        member,
      });
      // Nodes write a marker per rollout once they run its program; a
      // creator can't overwrite the program.
      const markerGrant = yield* IAM.Member(`${id}RolloutGrant`, {
        kind: "storage.bucket",
        name: bucket.bucketName,
        role: "roles/storage.objectCreator",
        member,
      });
      // The control plane's token reaches the nodes from Secret Manager,
      // never metadata, unless the pool names a secret of its own for it.
      const token =
        options.secrets?.RIVET_TOKEN === undefined
          ? (yield* SecretManager.Secret(`${id}Token`, {
              value: nodes.environment.RIVET_TOKEN,
            })).version.pipe(Output.map((version) => version ?? ""))
          : undefined;
      // Nodes read each secret themselves: grant the secret, not the project.
      // Secrets the classes read as config: one secret of the pool's, loaded
      // by the node at start, never metadata or the worker pool's config.
      const split = splitNodeEnvironment(nodes);
      const secretEnvVersion = (yield* SecretManager.Secret(`${id}SecretEnv`, {
        value: split.pipe(Output.map(({ secrets }) => Redacted.make(JSON.stringify(secrets)))),
      })).version.pipe(Output.map((version) => version ?? ""));
      const secrets = Object.entries({
        ...(token === undefined ? {} : { RIVET_TOKEN: token }),
        [SECRET_ENV]: secretEnvVersion,
        ...options.secrets,
      });
      const secretGrants: Array<Output.Output<string>> = [];
      for (const [name, version] of secrets) {
        const secretGrant = yield* IAM.Member(`${id}Secret${name}`, {
          kind: "secretmanager.secret",
          name: asOutput(version).pipe(Output.map((v) => v.replace(/\/versions\/[^/]+$/, ""))),
          role: "roles/secretmanager.secretAccessor",
          member,
        });
        secretGrants.push(secretGrant.role);
      }
      // `NAME=version` lines: the versions, never the values.
      const secretVersions = Output.all(
        ...secrets.map(([name, version]) =>
          asOutput(version).pipe(Output.map((v) => `${name}=${v}`)),
        ),
      ).pipe(Output.map((lines) => lines.join("\n")));

      // A bare VM has no hosted runtime to name the stack: the node's
      // runtime reads it from its env, as on every other host.
      const stack = yield* Stack;
      // A Docker env file: one `NAME=value` per line.
      const own = Output.all(
        ...Object.entries(options.env ?? {}).map(([name, value]) =>
          asOutput(value).pipe(Output.map((v) => [name, v] as const)),
        ),
      ).pipe(Output.map((entries) => Object.fromEntries(entries)));
      const envFile = Output.all(split.pipe(Output.map(({ plain }) => plain)), own).pipe(
        Output.map(([env, extra]) =>
          Object.entries({
            ...env,
            ...extra,
            ALCHEMY_STACK_NAME: stack.name,
            ALCHEMY_STAGE: stack.stage,
            ALCHEMY_PHASE: "runtime",
          })
            // A secret reaches the node from Secret Manager, never metadata.
            .filter(([name]) => !secrets.some(([secret]) => secret === name))
            .map(([name, value]) => `${name}=${String(value).replaceAll("\n", " ")}`)
            .join("\n"),
        ),
      );
      const replicas = options.replicas ?? 1;
      // What every node runs, the same on each; its hash names the rollout.
      const shared = Output.all(
        bucket.bucketName,
        program.md5Hash,
        envFile,
        secretVersions,
        grant.role,
        markerGrant.role,
        // Nodes read their secrets once the grants exist.
        Output.all(...secretGrants),
      ).pipe(
        Output.map(([bucketName, programHash, env, versions]) => {
          const values = {
            "startup-script": startupScript({
              bucket: bucketName,
              image,
              stopTimeout: options.stopTimeout ?? 30,
              rolloutTimeout: options.rolloutTimeout ?? 600,
              rivetkitVersion: options.rivetkitVersion ?? nodes.rivetkitVersion,
            }),
            [HASH_KEY]: programHash ?? "",
            [ENV_KEY]: env,
            [SECRETS_KEY]: versions,
            [REPLICAS_KEY]: String(replicas),
          };
          return {
            ...values,
            [ROLLOUT_KEY]: createHash("sha256")
              .update(JSON.stringify(values))
              .digest("hex")
              .slice(0, 16),
          };
        }),
      );
      const metadata = (index: number) =>
        shared.pipe(Output.map((values) => ({ ...values, [INDEX_KEY]: String(index) })));

      for (let i = 0; i < replicas; i++) {
        yield* Compute.Instance(`${id}Node${i}`, {
          zone: zones[i % zones.length]!,
          machineType,
          sourceImage: COS_IMAGE,
          network: Output.interpolate`global/networks/${asOutput(network)}`,
          subnetwork: Output.interpolate`regions/${region}/subnetworks/${asOutput(subnetwork)}`,
          associatePublicIp: true,
          serviceAccount: email,
          oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
          metadata: metadata(i) as unknown as Record<string, string>,
        });
      }
    }),
  });
