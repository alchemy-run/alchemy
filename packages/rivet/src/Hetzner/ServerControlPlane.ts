import * as Hetzner from "@alchemy.run/hetzner";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Cluster } from "../Cluster.ts";
import { adminToken } from "../internal/AdminToken.ts";
import {
  objectStorageEnvironment,
  ObjectStorageRequired,
  type ObjectStorage,
} from "../internal/ObjectStorage.ts";
import { Namespace } from "../Namespace.ts";

export { ObjectStorageRequired, type ObjectStorage } from "../internal/ObjectStorage.ts";

/** The engine release `RivetHetzner.ServerControlPlane` runs by default. */
export const DEFAULT_ENGINE_IMAGE = "rivetdev/engine:3.0.0";

/** Hetzner's Ubuntu image with Docker preinstalled. */
const DOCKER_IMAGE = "docker-ce";
const MOUNT_PATH = "/mnt/rivet";
const DATA_PATH = "/var/lib/rivet";
const API_PORT = 6420;
const PEER_PORT = 6421;

export interface ServerControlPlaneProps {
  /**
   * Number of engines, one Server each with a Volume of its own. More than
   * one needs {@link objectStorage}. Run 3 or more in production.
   * @default 1
   */
  instances?: number;
  /**
   * Hetzner location of the Servers, Volumes and Load Balancer.
   * @default "nbg1"
   */
  location?: string;
  /**
   * Server type of each engine.
   * @default "cx23"
   */
  serverType?: string;
  /**
   * Size of each engine's Volume, in GB (at least 10).
   * @default 10
   */
  diskSize?: number;
  /**
   * Engine image.
   * @default "rivetdev/engine:3.0.0"
   */
  image?: string;
  /**
   * Where engines keep the durable copy of every actor's data, shared by
   * all of them: an S3-compatible bucket (Hetzner Object Storage, R2, S3)
   * or a GCS bucket. Without it, a single engine keeps it on its Volume.
   */
  objectStorage?: ObjectStorage;
  /**
   * Server type of the edge, the Server running Caddy that serves the
   * engines over HTTPS.
   * @default "cx23"
   */
  edgeServerType?: string;
  /**
   * IPv4 range of the engines' private Network.
   * @default "10.45.0.0/16"
   */
  ipRange?: string;
}

/** The network zone a location belongs to. */
const networkZoneOf = (location: string) =>
  location.startsWith("ash")
    ? "us-east"
    : location.startsWith("hil")
      ? "us-west"
      : location.startsWith("sin")
        ? "ap-southeast"
        : "eu-central";

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/**
 * Boot one engine: mount its Volume, find its address on the private
 * Network, then run the engine on the host network.
 */
const userData = (options: {
  readonly image: string;
  readonly volumeId: number;
  readonly environment: ReadonlyArray<readonly [string, string]>;
}) => `#!/bin/bash
set -euo pipefail
DEVICE=/dev/disk/by-id/scsi-0HC_Volume_${options.volumeId}
for _ in $(seq 1 60); do [ -e "$DEVICE" ] && break; sleep 2; done
blkid "$DEVICE" >/dev/null || mkfs.ext4 -F "$DEVICE"
mkdir -p ${MOUNT_PATH}
grep -q " ${MOUNT_PATH} " /etc/fstab || echo "$DEVICE ${MOUNT_PATH} ext4 discard,nofail,defaults 0 0" >> /etc/fstab
mountpoint -q ${MOUNT_PATH} || mount ${MOUNT_PATH}
PRIVATE_IP=""
for _ in $(seq 1 60); do
  PRIVATE_IP="$(curl -sf http://169.254.169.254/hetzner/v1/metadata/private-networks | grep -m1 -oE 'ip: [0-9.]+' | cut -d' ' -f2 || true)"
  [ -n "$PRIVATE_IP" ] && break
  sleep 2
done
until docker info >/dev/null 2>&1; do sleep 2; done
docker rm -f rivet-engine >/dev/null 2>&1 || true
docker run -d --name rivet-engine --restart always --network host \\
  -v ${MOUNT_PATH}:${DATA_PATH} \\
${options.environment.map(([name, value]) => `  -e ${name}=${shellQuote(value)} \\`).join("\n")}
  -e RIVET__API_PEER__ADVERTISE_ADDRESS="$PRIVATE_IP:${PEER_PORT}" \\
  ${shellQuote(options.image)}
`;

/** Caddy, the proxy that serves the engines over HTTPS. */
const EDGE_IMAGE = "caddy:2";

/**
 * Boot the edge: name it after its own public address under `sslip.io`,
 * which resolves any `a-b-c-d.sslip.io` to `a.b.c.d`, and run Caddy, which
 * gets a certificate for that name and proxies to the Load Balancer's
 * private address.
 */
const edgeUserData = (options: { readonly upstream: string }) => `#!/bin/bash
set -euo pipefail
PUBLIC_IP="$(curl -sf http://169.254.169.254/hetzner/v1/metadata/public-ipv4)"
mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<CADDY
$(echo "$PUBLIC_IP" | tr . -).sslip.io {
\treverse_proxy ${options.upstream} {
\t\tflush_interval -1
\t}
}
CADDY
until docker info >/dev/null 2>&1; do sleep 2; done
docker rm -f rivet-edge >/dev/null 2>&1 || true
docker run -d --name rivet-edge --restart always --network host \\
  -v /etc/caddy:/etc/caddy -v rivet-edge-data:/data \\
  ${EDGE_IMAGE}
`;

/** The edge's HTTPS address: its public IPv4 under `sslip.io`. */
const edgeEndpoint = (ipv4: string | undefined) =>
  `https://${(ipv4 ?? "").replaceAll(".", "-")}.sslip.io`;

/** A storage value as a string for the engine's environment. */
const plain = (value: unknown) => (Redacted.isRedacted(value) ? Redacted.value(value) : value);

/**
 * A Rivet control plane on Hetzner Cloud, as a `Rivet.Cluster` Layer:
 * Servers running the engine container, each with a Volume of its own, on a
 * private Network they talk to each other over, behind a private Load
 * Balancer. An edge Server runs Caddy in front of it and serves the engines
 * over HTTPS at its own address under `sslip.io`
 * (`https://203-0-113-7.sslip.io`), with a certificate from Let's Encrypt,
 * so it needs no domain of your own. A firewall drops every other inbound
 * connection to the engines. A namespace is created for the stage.
 *
 * One engine keeps actor data on its Volume. Several share it through
 * `objectStorage` — Hetzner Object Storage, or any S3-compatible bucket.
 *
 * Pools of nodes anywhere reach it at its public address —
 * `RivetHetzner.ServerPool` on Hetzner, or a pool on any other cloud.
 *
 * ### Running a control plane on Hetzner
 * **Example:** One engine
 * ```typescript
 * export const Cluster = RivetHetzner.ServerControlPlane("Rivet");
 * ```
 *
 * **Example:** Three engines sharing Hetzner Object Storage
 * ```typescript
 * export const Cluster = RivetHetzner.ServerControlPlane("Rivet", {
 *   instances: 3,
 *   objectStorage: {
 *     kind: "s3",
 *     bucket: "my-rivet-data",
 *     endpoint: "https://nbg1.your-objectstorage.com",
 *     region: "nbg1",
 *     accessKeyId: Config.String("HETZNER_S3_ACCESS_KEY_ID"),
 *     secretAccessKey: Config.Redacted("HETZNER_S3_SECRET_ACCESS_KEY"),
 *   },
 * });
 * ```
 *
 * @primitive
 */
export const ServerControlPlane = (id: string, props: ServerControlPlaneProps = {}) =>
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
            message: `RivetHetzner.ServerControlPlane("${id}") runs ${instances} engines, which share actor data through objectStorage.`,
          }),
        );
      }
      const location = props.location ?? "nbg1";
      const image = props.image ?? DEFAULT_ENGINE_IMAGE;
      const token = yield* adminToken(id);

      const network = yield* Hetzner.Network(`${id}Network`, {
        ipRange: props.ipRange ?? "10.45.0.0/16",
        subnets: [{ type: "cloud", networkZone: networkZoneOf(location) }],
      });
      // No inbound rules: only the Load Balancer, over the private Network,
      // reaches the engines.
      const firewall = yield* Hetzner.Firewall(`${id}Firewall`, {});

      const storage =
        props.objectStorage === undefined
          ? [["RIVET__OBJECT_STORAGE__PRIMARY__FILE_SYSTEM__PATH", `${DATA_PATH}/objects`] as const]
          : yield* objectStorageEnvironment(props.objectStorage);
      const environment = Output.all(
        token.text,
        ...storage.map(([, value]) =>
          Output.isOutput(value) ? value : Output.literal(value as unknown),
        ),
      ).pipe(
        Output.map(([text, ...values]) => [
          ["RIVET__AUTH__ADMIN_TOKEN", String(plain(text))] as const,
          ["RIVET__STORAGE__LOG_DIRECTORY", DATA_PATH] as const,
          ["RIVET__TELEMETRY__ENABLED", "false"] as const,
          ...storage.map(([name], i) => [name, String(plain(values[i]))] as const),
        ]),
      );

      const servers = [];
      for (let i = 0; i < instances; i++) {
        const volume = yield* Hetzner.Volume(`${id}Disk${i}`, {
          size: props.diskSize ?? 10,
          format: "ext4",
          location,
        });
        servers.push(
          yield* Hetzner.Server(`${id}Engine${i}`, {
            serverType: props.serverType ?? "cx23",
            // IPv4 only: a primary IP each counts against the project's limit.
            enableIpv6: false,
            image: DOCKER_IMAGE,
            location,
            networks: [network],
            firewalls: [firewall],
            volumes: [volume],
            userData: Output.all(volume.id, environment).pipe(
              Output.map(([volumeId, env]) => userData({ image, volumeId, environment: env })),
            ) as unknown as string,
          }),
        );
      }

      // Private only: it spreads calls across the engines, and the edge is
      // the one public way in.
      const balancer = yield* Hetzner.LoadBalancer(`${id}Api`, {
        loadBalancerType: "lb11",
        location,
        networks: [network],
        publicInterface: false,
        services: [
          {
            protocol: "tcp",
            listenPort: API_PORT,
            destinationPort: API_PORT,
            healthCheck: {
              protocol: "http",
              port: API_PORT,
              interval: 10,
              timeout: 5,
              retries: 3,
              http: { path: "/health" },
            },
          },
        ],
        targets: servers.map((server) => ({
          type: "server" as const,
          server,
          usePrivateIp: true,
        })),
      });

      // HTTPS without a domain of your own: a small Server running Caddy in
      // front of the Load Balancer, on its own address under `sslip.io`.
      const edgeFirewall = yield* Hetzner.Firewall(`${id}EdgeFirewall`, {
        rules: [
          { direction: "in", protocol: "tcp", port: "80", sourceIps: ["0.0.0.0/0", "::/0"] },
          { direction: "in", protocol: "tcp", port: "443", sourceIps: ["0.0.0.0/0", "::/0"] },
        ],
      });
      const edge = yield* Hetzner.Server(`${id}Edge`, {
        serverType: props.edgeServerType ?? "cx23",
        enableIpv6: false,
        image: DOCKER_IMAGE,
        location,
        networks: [network],
        firewalls: [edgeFirewall],
        userData: balancer.privateNetworks.pipe(
          Output.map((networks) =>
            edgeUserData({ upstream: `${networks[0]?.ip ?? ""}:${API_PORT}` }),
          ),
        ) as unknown as string,
      });
      const endpoint = edge.ipv4.pipe(Output.map(edgeEndpoint));
      const namespace = yield* Namespace(`${id}Namespace`, {
        // Created through the API the engines serve, once they all run.
        endpoint: Output.all(endpoint, Output.all(...servers.map((server) => server.id))).pipe(
          Output.map(([url]) => url),
        ),
        token: token.text,
      });
      return { endpoint, token: token.text, namespace: namespace.name };
    }),
  );
