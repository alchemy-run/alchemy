import * as Compute from "@alchemy.run/gcp/Compute";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import * as IAM from "@alchemy.run/gcp/IAM";
import * as SecretManager from "@alchemy.run/gcp/SecretManager";
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
const PASSWORD_KEY = "cluster-postgres-password";

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

/**
 * Mount the data disk, then run Postgres on the host network.
 *
 * Instance metadata is readable by anyone who can view the instance, so it
 * names the version of the secret holding the password, never the password:
 * the script reads it from Secret Manager into its own environment, and
 * Docker hands it to Postgres (`-e POSTGRES_PASSWORD`).
 */
const startupScript = (options: { image: string }) => `#!/bin/bash
set -euo pipefail
MD=http://metadata.google.internal/computeMetadata/v1
read_password() {
  local TOKEN VERSION BODY
  TOKEN="$(curl -sf -H 'Metadata-Flavor: Google' "$MD/instance/service-accounts/default/token" | sed -E 's/.*"access_token":"([^"]+)".*/\\1/')" || return 1
  VERSION="$(curl -sf -H 'Metadata-Flavor: Google' "$MD/instance/attributes/${PASSWORD_KEY}")" || return 1
  BODY="$(curl -sf -H "Authorization: Bearer $TOKEN" "https://secretmanager.googleapis.com/v1/$VERSION:access")" || return 1
  POSTGRES_PASSWORD="$(printf '%s' "$BODY" | tr -d '\\n' | sed -E 's/.*"data": *"([^"]*)".*/\\1/' | base64 -d)" || return 1
  export POSTGRES_PASSWORD
}
# A grant made with the instance takes a moment to reach Secret Manager.
TRIES=0
until read_password; do
  TRIES=$((TRIES + 1))
  if [ "$TRIES" -ge 60 ]; then
    echo "cluster-postgres: cannot read its password from Secret Manager" > /dev/ttyS0
    exit 1
  fi
  sleep 5
done
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
  -e POSTGRES_PASSWORD \\
  ${shellQuote(options.image)}
`;

/**
 * The database an Effect Cluster coordinates through, on Compute Engine,
 * as a `Cluster.Database` Layer: Postgres on an instance with a persistent
 * disk, in a VPC of its own that the pool's runners join. Only the runners reach
 * it; runners reach each other on the runner port.
 *
 * The Postgres password is kept in a Secret Manager secret of the
 * database's own, which only its instance's service account can read.
 * Instance metadata names its version, never its value.
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
      // The password in a secret of the database's own, which only its
      // instance reads: grant the secret, not the project.
      const account = yield* IAM.ServiceAccount(`${id}DatabaseAccount`, {
        displayName: "Effect Cluster database",
      });
      const passwordSecret = yield* SecretManager.Secret(`${id}PasswordSecret`, {
        value: password.text,
      });
      const passwordGrant = yield* IAM.Member(`${id}PasswordSecretGrant`, {
        kind: "secretmanager.secret",
        name: passwordSecret.name,
        role: "roles/secretmanager.secretAccessor",
        member: Output.interpolate`serviceAccount:${account.email}`,
      });
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
        serviceAccount: account.email,
        oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
        metadata: {
          "startup-script": startupScript({ image: props.image ?? "postgres:17-alpine" }),
          // The version, never the value; read once the grant exists.
          [PASSWORD_KEY]: Output.all(passwordSecret.version, passwordGrant.role).pipe(
            Output.map(([version]) => version ?? ""),
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
