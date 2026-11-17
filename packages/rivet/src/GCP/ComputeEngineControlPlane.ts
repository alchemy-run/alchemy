import * as Compute from "@alchemy.run/gcp/Compute";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import * as IAM from "@alchemy.run/gcp/IAM";
import * as Run from "@alchemy.run/gcp/Run";
import * as Storage from "@alchemy.run/gcp/Storage";
import * as VpcAccess from "@alchemy.run/gcp/VpcAccess";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Cluster } from "../Cluster.ts";
import { adminToken } from "../internal/AdminToken.ts";
import { stackDnsLabel } from "../internal/PoolHost.ts";
import { Namespace } from "../Namespace.ts";

/** The engine release `RivetGCP.ComputeEngineControlPlane` runs by default. */
export const DEFAULT_ENGINE_IMAGE = "rivetdev/engine:3.0.0";

/** Container-Optimized OS: Docker preinstalled, a read-only root. */
const COS_IMAGE = "projects/cos-cloud/global/images/family/cos-stable";
const DISK_DEVICE = "rivet-data";
const MOUNT_PATH = "/mnt/disks/rivet";
const DATA_PATH = "/var/lib/rivet";
const API_PORT = 6420;
const PEER_PORT = 6421;

/** The proxy in front of the engines: Caddy, spreading calls across them. */
const PROXY_IMAGE = "docker.io/library/caddy:2";

/**
 * The proxy's Caddyfile. Cloud Run terminates TLS and sets `PORT`; Caddy
 * spreads calls across the engines that pass their health check, and
 * streams responses without buffering.
 */
const PROXY_CADDYFILE = `{
\tadmin off
\tauto_https off
}
:{$PORT} {
\treverse_proxy {$UPSTREAMS} {
\t\tlb_policy round_robin
\t\tlb_try_duration 10s
\t\thealth_uri /health
\t\thealth_interval 10s
\t\tflush_interval -1
\t}
}
`;

export interface ComputeEngineControlPlaneProps {
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
   * @default "rivetdev/engine:3.0.0"
   */
  image?: string;
  /**
   * IPv4 range of the control plane's subnetwork.
   * @default "10.44.0.0/20"
   */
  cidrBlock?: string;
  /**
   * An unused `/28` in the network for the Serverless VPC Access connector
   * the HTTPS proxy reaches the engines through.
   * @default "10.44.16.0/28"
   */
  connectorCidrBlock?: string;
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
# Container-Optimized OS drops inbound traffic except SSH: open the engine's ports.
iptables -C INPUT -p tcp --dport ${API_PORT} -j ACCEPT 2>/dev/null || iptables -A INPUT -p tcp --dport ${API_PORT} -j ACCEPT
iptables -C INPUT -p tcp --dport ${PEER_PORT} -j ACCEPT 2>/dev/null || iptables -A INPUT -p tcp --dport ${PEER_PORT} -j ACCEPT
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
# The engine's logs on the serial console (\`gcloud compute instances get-serial-port-output\`).
setsid sh -c 'docker logs -f rivet-engine 2>&1 | sed -u "s/^/rivet-engine: /" > /dev/ttyS0' >/dev/null 2>&1 < /dev/null &
`;

/**
 * A Rivet control plane on Compute Engine, as a `Rivet.Cluster` Layer:
 * instances across zones, each running the engine container with a
 * persistent disk of its own, a Cloud Storage bucket for the durable copy of
 * every actor's data (reached as the instances' own service account), and a
 * Cloud Run service in front. Callers reach it over HTTPS at the service's
 * `run.app` address, so it needs no domain of your own; the service proxies
 * to the engines through a Serverless VPC Access connector, and the engines
 * take no traffic from outside their network. Instances find each other through the
 * bucket and talk on a private port only they can reach. A namespace is
 * created for the stage.
 *
 * Each data disk is its own resource, so it outlives the instance it is
 * attached to: a replaced instance mounts the same disk again.
 *
 * ### Running a control plane on GCP
 * **Example:** Three instances
 * ```typescript
 * export const Cluster = RivetGCP.ComputeEngineControlPlane("Rivet");
 * ```
 *
 * **Example:** Larger instances and disks
 * ```typescript
 * export const Cluster = RivetGCP.ComputeEngineControlPlane("Rivet", {
 *   machineType: "n2-standard-4",
 *   diskSize: 100,
 * });
 * ```
 *
 * @primitive
 */
export const ComputeEngineControlPlane = (id: string, props: ComputeEngineControlPlaneProps = {}) =>
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

      const token = yield* adminToken(id);
      const network = yield* Compute.Network(`${id}Network`, { autoCreateSubnetworks: false });
      const cidrBlock = props.cidrBlock ?? "10.44.0.0/20";
      const subnet = yield* Compute.Subnetwork(`${id}Subnet`, {
        network: network.networkName,
        region,
        ipCidrRange: cidrBlock,
      });
      const connectorCidrBlock = props.connectorCidrBlock ?? "10.44.16.0/28";
      // The API port is open only inside the network: to the proxy, which
      // sends from its connector's range, and to nodes in the subnetwork.
      yield* Compute.Firewall(`${id}ApiFirewall`, {
        network: network.networkName,
        direction: "INGRESS",
        allowed: [{ protocol: "tcp", ports: [String(API_PORT)] }],
        sourceRanges: [cidrBlock, connectorCidrBlock],
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
            network: Output.interpolate`global/networks/${network.networkName}`,
            subnetwork: Output.interpolate`regions/${region}/subnetworks/${subnet.subnetworkName}`,
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

      // HTTPS without a domain of your own: a Cloud Run service's address,
      // running a proxy that reaches the engines through a Serverless VPC
      // Access connector. (Direct VPC egress holds the subnetwork's
      // addresses for 1-2 hours after the service is deleted, so the
      // control plane couldn't be destroyed.)
      const connector = yield* VpcAccess.Connector(`${id}Connector`, {
        location: region,
        network: network.networkName,
        ipCidrRange: connectorCidrBlock,
        machineType: "e2-micro",
        minInstances: 2,
        maxInstances: 3,
      });
      const upstreams = Output.all(...hosts.map((host) => host.networkIP)).pipe(
        Output.map((addresses) => addresses.map((ip) => `${ip}:${API_PORT}`).join(" ")),
      );
      const proxy = yield* Run.Service(`${id}Proxy`, {
        location: region,
        ingress: "INGRESS_TRAFFIC_ALL",
        // The engines check every call's token themselves.
        invokerIamDisabled: true,
        template: {
          // Nodes hold one connection each, as long as Cloud Run allows.
          timeout: "3600s",
          maxInstanceRequestConcurrency: 1000,
          vpcAccess: { connector: connector.name, egress: "PRIVATE_RANGES_ONLY" },
          containers: [
            {
              image: PROXY_IMAGE,
              command: ["sh", "-c"],
              args: [
                'printf "%s" "$CADDYFILE" > /tmp/Caddyfile && exec caddy run --adapter caddyfile --config /tmp/Caddyfile',
              ],
              env: [
                { name: "CADDYFILE", value: PROXY_CADDYFILE },
                { name: "UPSTREAMS", value: upstreams },
              ],
              ports: [{ containerPort: 8080 }],
            },
          ],
        },
      });

      const endpoint = proxy.uri.pipe(
        Output.map((uri) => (uri ?? "").replace(/\/+$/, "")),
      ) as Output.Output<string>;
      const namespace = yield* Namespace(`${id}Namespace`, {
        // Created through the API the instances serve, once they all run.
        endpoint: Output.all(endpoint, grant.role).pipe(Output.map(([url]) => url)),
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
