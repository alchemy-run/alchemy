import * as Compute from "@alchemy.run/gcp/Compute";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import * as IAM from "@alchemy.run/gcp/IAM";
import * as Storage from "@alchemy.run/gcp/Storage";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import { loadNodeImage, saveNodeImage } from "../internal/NodeImage.ts";
import {
  bundleNodes,
  isImageProgram,
  makePoolLayer,
  nodeEnvironment,
  RIVETKIT_VERSION,
  type PoolSettings,
} from "../internal/PoolHost.ts";

/** Container-Optimized OS: Docker preinstalled, a read-only root. */
const COS_IMAGE = "projects/cos-cloud/global/images/family/cos-stable";
const NODE_IMAGE = "node:26-slim";
const APP_PATH = "/var/lib/rivet-node";
const HASH_KEY = "rivet-node-hash";
const ENV_KEY = "rivet-node-env";

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

/** Fetch the node program from the bucket, then run it with Docker. */
const runProgram = (bucket: string, image: boolean) =>
  image
    ? // A Rust program is a whole image: load it, and run it as it is.
      `curl -sf -H "Authorization: Bearer $TOKEN" -o ${APP_PATH}/node.tar.next \\
    "https://storage.googleapis.com/storage/v1/b/${bucket}/o/node.tar?alt=media" \\
    && mv ${APP_PATH}/node.tar.next ${APP_PATH}/node.tar
  curl -sf -H 'Metadata-Flavor: Google' "$MD/instance/attributes/${ENV_KEY}" > ${APP_PATH}/env.list
  ${loadNodeImage(`${APP_PATH}/node.tar`)}
  docker rm -f rivet-node >/dev/null 2>&1 || true
  docker run -d --name rivet-node --restart always --network host \\
    --env-file ${APP_PATH}/env.list "$IMAGE"`
    : `curl -sf -H "Authorization: Bearer $TOKEN" -o ${APP_PATH}/node.mjs.next \\
    "https://storage.googleapis.com/storage/v1/b/${bucket}/o/node.mjs?alt=media" \\
    && mv ${APP_PATH}/node.mjs.next ${APP_PATH}/node.mjs
  curl -sf -H 'Metadata-Flavor: Google' "$MD/instance/attributes/${ENV_KEY}" > ${APP_PATH}/env.list
  docker rm -f rivet-node >/dev/null 2>&1 || true
  docker run -d --name rivet-node --restart always --network host \\
    --env-file ${APP_PATH}/env.list -v ${APP_PATH}/node.mjs:/program/node.mjs:ro -w /app ${NODE_IMAGE} \\
    sh -c 'cp /program/node.mjs . && npm install --no-save --no-fund --no-audit rivetkit@${RIVETKIT_VERSION} && exec node node.mjs'`;

const startupScript = (options: {
  readonly bucket: string;
  readonly image: boolean;
}) => `#!/bin/bash
set -uo pipefail
MD=http://metadata.google.internal/computeMetadata/v1
mkdir -p ${APP_PATH}
start() {
  TOKEN="$(curl -sf -H 'Metadata-Flavor: Google' "$MD/instance/service-accounts/default/token" | sed -E 's/.*"access_token":"([^"]+)".*/\\1/')"
  ${runProgram(options.bucket, options.image)}
}
etag() {
  curl -sf -H 'Metadata-Flavor: Google' -D - -o /dev/null "$MD/instance/attributes/?recursive=true$1" \\
    | grep -i '^etag:' | awk '{print $2}' | tr -d '\\r'
}
start
# On any change, run the current startup script again: it starts the node
# afresh and waits for the next change, so a new script reaches this node too.
(
  ETAG="$(etag "")"
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
 * container on every instance in place.
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

      const account = yield* IAM.ServiceAccount(`${id}NodeAccount`, {
        displayName: "Rivet pool nodes",
      });
      const grant = yield* IAM.Member(`${id}ProgramGrant`, {
        kind: "storage.bucket",
        name: bucket.bucketName,
        role: "roles/storage.objectViewer",
        member: Output.interpolate`serviceAccount:${account.email}`,
      });

      // A bare VM has no hosted runtime to name the stack: the node's
      // runtime reads it from its env, as on every other host.
      const stack = yield* Stack;
      // A Docker env file: one `NAME=value` per line.
      const envFile = nodeEnvironment(nodes).pipe(
        Output.map((env) =>
          Object.entries({
            ...env,
            ALCHEMY_STACK_NAME: stack.name,
            ALCHEMY_STAGE: stack.stage,
            ALCHEMY_PHASE: "runtime",
          })
            .map(([name, value]) => `${name}=${String(value).replaceAll("\n", " ")}`)
            .join("\n"),
        ),
      );
      const metadata = Output.all(bucket.bucketName, program.md5Hash, envFile, grant.role).pipe(
        Output.map(([bucketName, programHash, env]) => ({
          "startup-script": startupScript({ bucket: bucketName, image }),
          [HASH_KEY]: programHash ?? "",
          [ENV_KEY]: env,
        })),
      );

      for (let i = 0; i < (options.replicas ?? 1); i++) {
        yield* Compute.Instance(`${id}Node${i}`, {
          zone: zones[i % zones.length]!,
          machineType,
          sourceImage: COS_IMAGE,
          network: Output.interpolate`global/networks/${asOutput(network)}`,
          subnetwork: Output.interpolate`regions/${region}/subnetworks/${asOutput(subnetwork)}`,
          associatePublicIp: true,
          serviceAccount: account.email,
          oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
          metadata: metadata as unknown as Record<string, string>,
        });
      }
    }),
  });
