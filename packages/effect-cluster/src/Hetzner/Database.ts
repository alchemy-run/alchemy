import * as Hetzner from "@alchemy.run/hetzner";
import * as Output from "alchemy/Output";
import { Random } from "alchemy/Random";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { clusterShardGroups, Database as ClusterDatabase } from "../Database.ts";
import type { Providers } from "../Providers.ts";

export interface DatabaseProps {
  /**
   * Hetzner location of the database and the cluster's Network.
   * @default "nbg1"
   */
  location?: string;
  /**
   * Server type of the database.
   * @default "cx23"
   */
  serverType?: string;
  /**
   * Size of the database's Volume, in GB (at least 10).
   * @default 10
   */
  diskSize?: number;
  /**
   * Postgres image.
   * @default "postgres:17-alpine"
   */
  image?: string;
  /**
   * IPv4 range of the cluster's private Network.
   * @default "10.46.0.0/16"
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

/** Mount the Volume and run Postgres on it, on the Server's own network. */
const userData = (options: { volumeId: number; image: string; password: string }) => `#!/bin/bash
set -euo pipefail
DEVICE=/dev/disk/by-id/scsi-0HC_Volume_${options.volumeId}
for _ in $(seq 1 60); do [ -e "$DEVICE" ] && break; sleep 2; done
blkid "$DEVICE" >/dev/null || mkfs.ext4 -F "$DEVICE"
mkdir -p /mnt/postgres
grep -q " /mnt/postgres " /etc/fstab || echo "$DEVICE /mnt/postgres ext4 discard,nofail,defaults 0 0" >> /etc/fstab
mountpoint -q /mnt/postgres || mount /mnt/postgres
until docker info >/dev/null 2>&1; do sleep 2; done
docker rm -f postgres >/dev/null 2>&1 || true
docker run -d --name postgres --restart always --network host \\
  -v /mnt/postgres:/var/lib/postgresql/data \\
  -e PGDATA=/var/lib/postgresql/data/pgdata \\
  -e POSTGRES_DB=cluster \\
  -e POSTGRES_PASSWORD=${shellQuote(options.password)} \\
  ${shellQuote(options.image)}
`;

/**
 * The database an Effect Cluster coordinates through, on Hetzner Cloud, as
 * a `Cluster.Database` Layer: Postgres on a Server with a Volume, on a
 * private Network that the pool's Servers attach to. A firewall drops every
 * inbound connection on the Server's public address; runners reach it
 * over the Network.
 *
 * ### Running the database on Hetzner
 * **Example:** Postgres in Nuremberg
 * ```typescript
 * export const Database = ClusterHetzner.Database("Cluster");
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
      const location = props.location ?? "nbg1";
      const ipRange = props.ipRange ?? "10.46.0.0/16";
      const password = yield* Random(`${id}Password`, { bytes: 24 }) as unknown as Effect.Effect<
        Random,
        never,
        Providers
      >;
      const network = yield* Hetzner.Network(`${id}Network`, {
        ipRange,
        subnets: [{ type: "cloud", networkZone: networkZoneOf(location) }],
      });
      // No inbound rules: only the Network reaches Postgres.
      const firewall = yield* Hetzner.Firewall(`${id}Firewall`, {});
      const volume = yield* Hetzner.Volume(`${id}Data`, {
        size: props.diskSize ?? 10,
        format: "ext4",
        location,
      });
      const server = yield* Hetzner.Server(`${id}Postgres`, {
        serverType: props.serverType ?? "cx23",
        // Hetzner's Ubuntu image with Docker preinstalled.
        image: "docker-ce",
        location,
        // IPv4 pulls the Postgres image; IPv6 would only spend an address.
        enableIpv6: false,
        networks: [network],
        firewalls: [firewall],
        volumes: [volume],
        userData: Output.all(volume.id, password.text).pipe(
          Output.map(([volumeId, text]) =>
            userData({
              volumeId,
              image: props.image ?? "postgres:17-alpine",
              password: Redacted.value(text),
            }),
          ),
        ) as unknown as string,
      });
      return {
        url: Output.all(server.privateIps, password.text).pipe(
          Output.map(([ips, text]) =>
            Redacted.make(
              `postgres://postgres:${encodeURIComponent(text.pipe(Redacted.value))}@${ips[0]}:5432/cluster`,
            ),
          ),
        ),
        network: { kind: "hetzner" as const, networkId: network.networkId, ipRange, location },
        shardGroups: yield* clusterShardGroups(id),
      };
    }),
  );
