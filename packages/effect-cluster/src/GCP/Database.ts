import * as Compute from "@alchemy.run/gcp/Compute";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import * as Output from "alchemy/Output";
import { Random } from "alchemy/Random";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { clusterShardGroups, Database as ClusterDatabase } from "../Database.ts";
import { RUNNER_PORT } from "../internal/Gateway.ts";
import { stackDnsLabel } from "../internal/Naming.ts";
import type { Providers } from "../Providers.ts";

export const COS_IMAGE = "projects/cos-cloud/global/images/family/cos-stable";
const DISK_DEVICE = "cluster-data";
const MOUNT_PATH = "/mnt/disks/postgres";

export interface DatabaseProps {
  /**
   * Zone of the database instance.
   * @default the region's `-a` zone
   */
  zone?: string;
  /**
   * Machine type of the database instance.
   * @default "e2-small"
   */
  machineType?: string;
  /**
   * Size of the database's disk, in GB.
   * @default 20
   */
  diskSize?: number;
  /**
   * Postgres image.
   * @default "postgres:17-alpine"
   */
  image?: string;
  /**
   * IPv4 range of the cluster's subnetwork.
   * @default "10.47.0.0/20"
   */
  cidrBlock?: string;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/** Mount the data disk, then run Postgres on the host network. */
const startupScript = (options: { image: string; password: string }) => `#!/bin/bash
set -euo pipefail
DEVICE=/dev/disk/by-id/google-${DISK_DEVICE}
blkid "$DEVICE" >/dev/null || mkfs.ext4 -F "$DEVICE"
mkdir -p ${MOUNT_PATH}
mountpoint -q ${MOUNT_PATH} || mount "$DEVICE" ${MOUNT_PATH}
# Container-Optimized OS drops inbound traffic except SSH: open Postgres.
iptables -C INPUT -p tcp --dport 5432 -j ACCEPT 2>/dev/null || iptables -A INPUT -p tcp --dport 5432 -j ACCEPT
docker rm -f postgres >/dev/null 2>&1 || true
docker run -d --name postgres --restart always --network host \\
  -v ${MOUNT_PATH}:/var/lib/postgresql/data \\
  -e PGDATA=/var/lib/postgresql/data/pgdata \\
  -e POSTGRES_DB=cluster \\
  -e POSTGRES_PASSWORD=${shellQuote(options.password)} \\
  ${shellQuote(options.image)}
`;

/**
 * The database an Effect Cluster coordinates through, on Compute Engine,
 * as a `Cluster.Database` Layer: Postgres on an instance with a persistent
 * disk, in a VPC of its own that the pool's runners join. Only the runners reach
 * it; runners reach each other on the runner port.
 *
 * ### Running the database on GCP
 * **Example:** Postgres on Compute Engine
 * ```typescript
 * export const Database = ClusterGCP.Database("Cluster");
 * ```
 *
 * @primitive
 */
export const Database = (id: string, props: DatabaseProps = {}) =>
  Layer.effect(
    ClusterDatabase,
    Effect.gen(function* () {
      if (globalThis.__ALCHEMY_RUNTIME__) {
        // Runners read their database from their own environment at runtime.
        return { url: Redacted.make(""), shardGroups: undefined as never };
      }
      const region = yield* GcpEnvironment.current.pipe(
        Effect.map((env) => env.region),
        Effect.orDie,
      );
      const zone = props.zone ?? `${region}-a`;
      const cidr = props.cidrBlock ?? "10.47.0.0/20";
      const poolTag = yield* stackDnsLabel(`${id}-pool`, 63);
      const databaseTag = yield* stackDnsLabel(`${id}-db`, 63);
      const network = yield* Compute.Network(`${id}Network`, { autoCreateSubnetworks: false });
      const subnet = yield* Compute.Subnetwork(`${id}Subnet`, {
        network: network.networkName,
        region,
        ipCidrRange: cidr,
      });
      yield* Compute.Firewall(`${id}DatabaseFirewall`, {
        network: network.networkName,
        direction: "INGRESS",
        allowed: [{ protocol: "tcp", ports: ["5432"] }],
        sourceTags: [poolTag],
        targetTags: [databaseTag],
      });
      // Runners send each other messages for the shards they own.
      yield* Compute.Firewall(`${id}RunnerFirewall`, {
        network: network.networkName,
        direction: "INGRESS",
        allowed: [{ protocol: "tcp", ports: [String(RUNNER_PORT)] }],
        sourceTags: [poolTag],
        targetTags: [poolTag],
      });
      const password = yield* Random(`${id}Password`, { bytes: 24 }) as unknown as Effect.Effect<
        Random,
        never,
        Providers
      >;
      const disk = yield* Compute.Disk(`${id}Disk`, {
        zone,
        type: "pd-balanced",
        sizeGb: props.diskSize ?? 20,
      });
      const instance = yield* Compute.Instance(`${id}Postgres`, {
        zone,
        machineType: props.machineType ?? "e2-small",
        sourceImage: COS_IMAGE,
        network: Output.interpolate`global/networks/${network.networkName}`,
        subnetwork: Output.interpolate`regions/${region}/subnetworks/${subnet.subnetworkName}`,
        // Pulls the Postgres image.
        associatePublicIp: true,
        tags: [databaseTag],
        attachedDisks: [
          { source: disk.selfLink as Output.Output<string>, deviceName: DISK_DEVICE },
        ],
        metadata: {
          "startup-script": password.text.pipe(
            Output.map((text) =>
              startupScript({
                image: props.image ?? "postgres:17-alpine",
                password: Redacted.value(text),
              }),
            ),
          ) as unknown as string,
        },
      });
      return {
        url: Output.all(instance.networkIP, password.text).pipe(
          Output.map(([ip, text]) =>
            Redacted.make(
              `postgres://postgres:${encodeURIComponent(text.pipe(Redacted.value))}@${ip}:5432/cluster`,
            ),
          ),
        ),
        network: {
          kind: "gcp" as const,
          network: network.networkName,
          subnetwork: subnet.subnetworkName,
          region,
          cidr,
          tag: poolTag,
        },
        shardGroups: yield* clusterShardGroups(id),
      };
    }),
  );
