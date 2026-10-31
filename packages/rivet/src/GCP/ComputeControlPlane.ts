import * as Compute from "@alchemy.run/gcp/Compute";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import * as IAM from "@alchemy.run/gcp/IAM";
import * as Storage from "@alchemy.run/gcp/Storage";
import * as Output from "alchemy/Output";
import { Random } from "alchemy/Random";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Cluster } from "../Cluster.ts";
import { stackDnsLabel } from "../internal/PoolHost.ts";
import { Namespace } from "../Namespace.ts";

/** The engine release `RivetGCP.ComputeControlPlane` runs by default. */
export const DEFAULT_ENGINE_IMAGE = "rivetdev/engine:3.0.0-preview.4";

/** Container-Optimized OS: Docker preinstalled, a read-only root. */
const COS_IMAGE = "projects/cos-cloud/global/images/family/cos-stable";
const DISK_DEVICE = "rivet-data";
const MOUNT_PATH = "/mnt/disks/rivet";
const DATA_PATH = "/var/lib/rivet";
const API_PORT = 6420;
const PEER_PORT = 6421;

export interface ComputeControlPlaneProps {
  /**
   * Number of control plane instances, spread across zones. Run 3 or more
   * in production.
   * @default 3
   */
  instances?: number;
  /**
   * Machine type of each instance.
   * @default "e2-standard-2"
   */
  machineType?: string;
  /**
   * Size of each instance's data disk, in GB.
   * @default 20
   */
  diskSize?: number;
  /**
   * Zones the instances are spread across, in the stack's region.
   * @default the region's `-a`, `-b` and `-c` zones
   */
  zones?: string[];
  /**
   * Engine image.
   * @default "rivetdev/engine:3.0.0-preview.4"
   */
  image?: string;
  /**
   * IPv4 range of the control plane's subnetwork.
   * @default "10.44.0.0/20"
   */
  cidrBlock?: string;
}

/** Boot one instance: mount its data disk, then run the engine on the host network. */
const startupScript = (options: {
  readonly image: string;
  readonly token: string;
  readonly bucket: string;
}) => `#!/bin/bash
set -euo pipefail
DEVICE=/dev/disk/by-id/google-${DISK_DEVICE}
blkid "$DEVICE" >/dev/null || mkfs.ext4 -F "$DEVICE"
mkdir -p ${MOUNT_PATH}
mountpoint -q ${MOUNT_PATH} || mount "$DEVICE" ${MOUNT_PATH}
PRIVATE_IP="$(curl -sf -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/ip)"
docker rm -f rivet-engine >/dev/null 2>&1 || true
docker run -d --name rivet-engine --restart always --network host \\
  -v ${MOUNT_PATH}:${DATA_PATH} \\
  -e RIVET__AUTH__ADMIN_TOKEN='${options.token}' \\
  -e RIVET__STORAGE__LOG_DIRECTORY=${DATA_PATH} \\
  -e RIVET__OBJECT_STORAGE__PRIMARY__GCS__BUCKET='${options.bucket}' \\
  -e RIVET__API_PEER__ADVERTISE_ADDRESS="$PRIVATE_IP:${PEER_PORT}" \\
  -e RIVET__TELEMETRY__ENABLED=false \\
  '${options.image}'
`;

/**
 * A Rivet control plane on Compute Engine, as a `Rivet.Cluster` Layer:
 * instances across zones, each running the engine container with a
 * persistent disk of its own, a Cloud Storage bucket for the durable copy of
 * every actor's data (reached as the instances' own service account), and a
 * regional network load balancer on a static address. Instances find each
 * other through the bucket and talk on a private port only they can reach.
 * A namespace is created for the stage.
 *
 * Each data disk is its own resource, so it outlives the instance it is
 * attached to: a replaced instance mounts the same disk again.
 *
 * ### Running a control plane on GCP
 * **Example:** Three instances
 * ```typescript
 * export const Cluster = RivetGCP.ComputeControlPlane("Rivet");
 * ```
 *
 * **Example:** Larger instances and disks
 * ```typescript
 * export const Cluster = RivetGCP.ComputeControlPlane("Rivet", {
 *   machineType: "n2-standard-4",
 *   diskSize: 100,
 * });
 * ```
 *
 * @primitive
 */
export const ComputeControlPlane = (id: string, props: ComputeControlPlaneProps = {}) =>
  Layer.effect(
    Cluster,
    Effect.gen(function* () {
      if (globalThis.__ALCHEMY_RUNTIME__) {
        // Nodes and callers read their endpoint and token from their own
        // environment at runtime; the cluster is only consulted while deploying.
        return { endpoint: "", token: Redacted.make(""), namespace: "default" };
      }
      const instances = props.instances ?? 3;
      const image = props.image ?? DEFAULT_ENGINE_IMAGE;
      const region = yield* GcpEnvironment.current.pipe(
        Effect.map((env) => env.region),
        Effect.orDie,
      );
      const zones = props.zones ?? [`${region}-a`, `${region}-b`, `${region}-c`];
      const tag = yield* stackDnsLabel(`${id}-engine`, 63);

      const token = yield* Random(`${id}AdminToken`, { bytes: 32 });
      const network = yield* Compute.Network(`${id}Network`, { autoCreateSubnetworks: false });
      const subnet = yield* Compute.Subnetwork(`${id}Subnet`, {
        network: network.networkName,
        region,
        ipCidrRange: props.cidrBlock ?? "10.44.0.0/20",
      });
      // A passthrough load balancer keeps the client's address: the API
      // port is open to nodes and callers anywhere.
      yield* Compute.Firewall(`${id}ApiFirewall`, {
        network: network.networkName,
        direction: "INGRESS",
        allowed: [{ protocol: "tcp", ports: [String(API_PORT)] }],
        sourceRanges: ["0.0.0.0/0"],
        targetTags: [tag],
      });
      // The peer port is plaintext and unauthenticated: only instances reach it.
      yield* Compute.Firewall(`${id}PeerFirewall`, {
        network: network.networkName,
        direction: "INGRESS",
        allowed: [{ protocol: "tcp", ports: [String(PEER_PORT)] }],
        sourceTags: [tag],
        targetTags: [tag],
      });

      const bucket = yield* Storage.Bucket(`${id}Data`, {
        location: region,
        forceDestroy: true,
        uniformBucketLevelAccess: true,
      });
      const account = yield* IAM.ServiceAccount(`${id}EngineAccount`, {
        displayName: "Rivet control plane",
      });
      const grant = yield* IAM.Member(`${id}StorageGrant`, {
        kind: "storage.bucket",
        name: bucket.bucketName,
        role: "roles/storage.objectAdmin",
        member: Output.interpolate`serviceAccount:${account.email}`,
      });

      const metadataScript = Output.all(token.text, bucket.bucketName).pipe(
        Output.map(([text, bucketName]) =>
          startupScript({ image, token: Redacted.value(text), bucket: bucketName }),
        ),
      );
      const hosts = [];
      for (let i = 0; i < instances; i++) {
        const zone = zones[i % zones.length]!;
        const disk = yield* Compute.Disk(`${id}Disk${i}`, {
          zone,
          type: "pd-balanced",
          sizeGb: props.diskSize ?? 20,
        });
        hosts.push(
          yield* Compute.Instance(`${id}Instance${i}`, {
            zone,
            machineType: props.machineType ?? "e2-standard-2",
            sourceImage: COS_IMAGE,
            network: network.networkName,
            subnetwork: subnet.subnetworkName,
            associatePublicIp: true,
            tags: [tag],
            serviceAccount: account.email,
            oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
            attachedDisks: [
              { source: disk.selfLink as Output.Output<string>, deviceName: DISK_DEVICE },
            ],
            metadata: { "startup-script": metadataScript },
          }),
        );
      }

      const health = yield* Compute.HttpHealthCheck(`${id}Health`, {
        port: API_PORT,
        requestPath: "/health",
      });
      const pool = yield* Compute.TargetPool(`${id}Engines`, {
        region,
        healthChecks: [health.selfLink as Output.Output<string>],
        instances: hosts.map((host) => host.selfLink as Output.Output<string>),
      });
      const address = yield* Compute.Address(`${id}Address`, { region });
      const rule = yield* Compute.ForwardingRule(`${id}Api`, {
        region,
        ipAddress: address.address as Output.Output<string>,
        ipProtocol: "TCP",
        portRange: String(API_PORT),
        target: pool.selfLink as Output.Output<string>,
        loadBalancingScheme: "EXTERNAL",
      });

      const endpoint = Output.interpolate`http://${address.address}:${API_PORT}`;
      const namespace = yield* Namespace(`${id}Namespace`, {
        // Created through the API the instances serve, once they all run.
        endpoint: Output.all(endpoint, rule.selfLink, grant.role).pipe(Output.map(([url]) => url)),
        token: token.text,
      });
      return {
        endpoint,
        network: {
          kind: "gcp",
          network: network.networkName,
          subnetwork: subnet.subnetworkName,
          region,
        },
        token: token.text,
        namespace: namespace.name,
      };
    }),
  );
