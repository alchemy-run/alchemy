import * as Compute from "@alchemy.run/gcp/Compute";
import * as IAM from "@alchemy.run/gcp/IAM";
import * as SecretManager from "@alchemy.run/gcp/SecretManager";
import * as Storage from "@alchemy.run/gcp/Storage";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import type { ClusterNetwork } from "../Database.ts";
import { GATEWAY_PORT, RUNNER_PORT } from "../internal/Gateway.ts";
import { makePoolLayer, type PoolSettings } from "../internal/PoolHost.ts";
import { SECRET_ENV } from "../internal/SecretEnv.ts";
import { COS_IMAGE } from "./Database.ts";

const NODE_IMAGE = "node:26-slim";
const APP_PATH = "/var/lib/cluster-runner";
const ENV_KEY = "cluster-runner-env";
const SECRETS_KEY = "cluster-runner-secrets";
const HASH_KEY = "cluster-runner-hash";

export interface ComputeEnginePoolOptions extends PoolSettings {
  /**
   * Number of runners, one instance each, spread across zones.
   * @default 2
   */
  replicas?: number;
  /**
   * Machine type of each runner.
   * @default "e2-small"
   */
  machineType?: string;
  /**
   * Zones the pool is spread across, in the database's region.
   * @default the region's `-a`, `-b` and `-c` zones
   */
  zones?: string[];
  /**
   * The VPC runners join when the database is on none, such as
   * `Cluster.Database.fromUrl`. `tag` is the network tag every runner
   * carries; a firewall must let it reach the other runners on port 34431
   * and the database. Ignored when the database is on a GCP network.
   */
  network?: Omit<Extract<ClusterNetwork, { kind: "gcp" }>, "kind">;
}

/**
 * Fetch the runner program from the bucket and run it on the host network.
 * When the instance's metadata changes (a new program, new environment), run
 * this script again, so every runner picks the change up.
 *
 * Instance metadata is readable by anyone who can view the instance, so it
 * names each secret's version, never its value: the script reads the values
 * from Secret Manager into its own environment, and Docker hands them to the
 * runner (`-e NAME`) without writing them anywhere.
 */
const startupScript = (options: { readonly bucket: string }) => `#!/bin/bash
set -uo pipefail
MD=http://metadata.google.internal/computeMetadata/v1
mkdir -p ${APP_PATH}
# Container-Optimized OS drops inbound traffic except SSH: open the runner's ports.
for PORT in ${RUNNER_PORT} ${GATEWAY_PORT}; do
  iptables -C INPUT -p tcp --dport $PORT -j ACCEPT 2>/dev/null || iptables -A INPUT -p tcp --dport $PORT -j ACCEPT
done
token() {
  TOKEN="$(curl -sf -H 'Metadata-Flavor: Google' "$MD/instance/service-accounts/default/token" | sed -E 's/.*"access_token":"([^"]+)".*/\\1/')"
}
fetch() {
  token
  curl -sf -H "Authorization: Bearer $TOKEN" -o ${APP_PATH}/$1.next \\
    "https://storage.googleapis.com/storage/v1/b/${options.bucket}/o/$1?alt=media" \\
    && mv ${APP_PATH}/$1.next ${APP_PATH}/$1
}
read_secrets() {
  token
  SECRET_ARGS=()
  while IFS='=' read -r NAME VERSION; do
    [ -n "$NAME" ] || continue
    BODY="$(curl -sf -H "Authorization: Bearer $TOKEN" "https://secretmanager.googleapis.com/v1/$VERSION:access")" || return 1
    VALUE="$(printf '%s' "$BODY" | tr -d '\\n' | sed -E 's/.*"data": *"([^"]*)".*/\\1/' | base64 -d)" || return 1
    export "$NAME=$VALUE"
    SECRET_ARGS+=(-e "$NAME")
  done <<< "$(curl -sf -H 'Metadata-Flavor: Google' "$MD/instance/attributes/${SECRETS_KEY}")"
}
start() {
  fetch runner.mjs
  curl -sf -H 'Metadata-Flavor: Google' "$MD/instance/attributes/${ENV_KEY}" > ${APP_PATH}/env.list
  # A grant made with the instance takes a moment to reach Secret Manager.
  # A runner that is already running keeps what it runs until they read.
  TRIES=0
  until read_secrets; do
    TRIES=$((TRIES + 1))
    if [ "$TRIES" -ge 60 ]; then
      echo "cluster-runner: cannot read its secrets from Secret Manager" > /dev/ttyS0
      return 1
    fi
    sleep 5
  done
  docker rm -f cluster-runner >/dev/null 2>&1 || true
  docker run -d --name cluster-runner --restart always --network host \\
    --env-file ${APP_PATH}/env.list "\${SECRET_ARGS[@]}" -v ${APP_PATH}:/app:ro -w /app ${NODE_IMAGE} node /app/runner.mjs
}
etag() {
  curl -sf -H 'Metadata-Flavor: Google' -D - -o /dev/null "$MD/instance/attributes/?recursive=true$1" \\
    | grep -i '^etag:' | awk '{print $2}' | tr -d '\\r'
}
start
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
# The runner's logs on the serial console (\`gcloud compute instances get-serial-port-output\`).
pgrep -f "docker logs -f cluster-runner" >/dev/null || setsid sh -c 'while true; do docker logs -f cluster-runner 2>&1 | sed -u "s/^/cluster-runner: /"; sleep 2; done > /dev/ttyS0' >/dev/null 2>&1 < /dev/null &
`;

/**
 * Run a pool of Effect Cluster runners on Compute Engine: instances in the
 * database's VPC, spread across zones, each running every class given these
 * runners from a Cloud Storage bucket, behind a regional load balancer on a
 * static address that serves their gateway to callers anywhere. Runners
 * reach each other and the database through the cluster's network tag.
 *
 * The database URL, the gateway token, and every other secret bound into
 * the runners' environment are kept in Secret Manager secrets of the
 * pool's own, which only the runners' service account can read. Instance
 * metadata names their versions, never their values.
 * With a database on no GCP network (`Cluster.Database.fromUrl`), give the
 * pool its `network`.
 *
 * Cloud Run can't host runners: runners take connections from each other.
 *
 * ### Running on Compute Engine
 * **Example:** Two runners
 * ```typescript
 * export const Database = ClusterGCP.Database("Cluster");
 * export const Default = ClusterGCP.ComputeEnginePool("Default", { replicas: 2 }).pipe(
 *   Layer.provide(Database),
 * );
 * ```
 *
 * @primitive
 */
export const ComputeEnginePool = (id: string, options: ComputeEnginePoolOptions = {}) =>
  makePoolLayer({
    label: "ClusterGCP.ComputeEnginePool",
    id,
    settings: options,
    expected: "a GCP network (ClusterGCP.Database)",
    secretsSeparately: true,
    network: (database) => (database.network?.kind === "gcp" ? database.network : undefined),
    ownNetwork: Effect.succeed(
      options.network === undefined ? undefined : { kind: "gcp" as const, ...options.network },
    ),
    // A static address, before the instances, so the URL never depends on it.
    gateway: (_name, network) =>
      Effect.gen(function* () {
        const address = yield* Compute.Address(`${id}GatewayAddress`, { region: network.region });
        return {
          url: Output.interpolate`http://${address.address}:${GATEWAY_PORT}`,
          address: address.address as Output.Output<string>,
        };
      }),
    nodes: ({ network, gateway, program, environment, secrets }) =>
      Effect.gen(function* () {
        const zones = options.zones ?? [
          `${network.region}-a`,
          `${network.region}-b`,
          `${network.region}-c`,
        ];
        // The gateway checks every call's token; the passthrough load
        // balancer keeps the caller's address.
        yield* Compute.Firewall(`${id}GatewayFirewall`, {
          network: network.network,
          direction: "INGRESS",
          allowed: [{ protocol: "tcp", ports: [String(GATEWAY_PORT)] }],
          sourceRanges: ["0.0.0.0/0"],
          targetTags: [network.tag],
        });
        const bucket = yield* Storage.Bucket(`${id}Program`, {
          location: network.region,
          forceDestroy: true,
          uniformBucketLevelAccess: true,
        });
        const runner = yield* Storage.Object(`${id}RunnerObject`, {
          bucketName: bucket.bucketName,
          key: "runner.mjs",
          file: program.pipe(Output.map((p) => `${p.dir}/runner.mjs`)) as unknown as string,
          contentType: "text/javascript",
        });
        const account = yield* IAM.ServiceAccount(`${id}RunnerAccount`, {
          displayName: "Effect Cluster runners",
        });
        const grant = yield* IAM.Member(`${id}ProgramGrant`, {
          kind: "storage.bucket",
          name: bucket.bucketName,
          role: "roles/storage.objectViewer",
          member: Output.interpolate`serviceAccount:${account.email}`,
        });
        // Each secret in a secret of the pool's own, which only the runners
        // read: grant the secret, not the project.
        const member = Output.interpolate`serviceAccount:${account.email}`;
        const secretVersions: Array<Output.Output<string>> = [];
        const secretGrants: Array<Output.Output<string>> = [];
        for (const [name, key] of [
          ["DatabaseUrl", "CLUSTER_DATABASE_URL"],
          ["GatewayToken", "CLUSTER_GATEWAY_TOKEN"],
          ["SecretEnv", SECRET_ENV],
        ] as const) {
          const secret = yield* SecretManager.Secret(`${id}${name}Secret`, {
            value: secrets.pipe(Output.map((s) => s[key])),
          });
          const secretGrant = yield* IAM.Member(`${id}${name}SecretGrant`, {
            kind: "secretmanager.secret",
            name: secret.name,
            role: "roles/secretmanager.secretAccessor",
            member,
          });
          // `NAME=version` lines: the versions, never the values.
          secretVersions.push(
            secret.version.pipe(Output.map((version) => `${key}=${version ?? ""}`)),
          );
          secretGrants.push(secretGrant.role);
        }
        // A Docker env file: one `NAME=value` per line. Each runner finds its
        // own address in the subnetwork's range.
        const envFile = environment.pipe(
          Output.map((env) =>
            Object.entries({ ...env, CLUSTER_RUNNER_NETWORK: network.cidr })
              .map(([name, value]) => `${name}=${String(value).replaceAll("\n", " ")}`)
              .join("\n"),
          ),
        );
        const metadata = Output.all(
          bucket.bucketName,
          runner.md5Hash,
          envFile,
          Output.all(...secretVersions),
          grant.role,
          // Runners read their secrets once the grants exist.
          Output.all(...secretGrants),
        ).pipe(
          Output.map(([bucketName, hash, env, versions]) => ({
            "startup-script": startupScript({ bucket: bucketName }),
            [HASH_KEY]: hash ?? "",
            [ENV_KEY]: env,
            [SECRETS_KEY]: versions.join("\n"),
          })),
        );
        const instances = [];
        for (let i = 0; i < (options.replicas ?? 2); i++) {
          instances.push(
            yield* Compute.Instance(`${id}Runner${i}`, {
              zone: zones[i % zones.length]!,
              machineType: options.machineType ?? "e2-small",
              sourceImage: COS_IMAGE,
              network: Output.interpolate`global/networks/${network.network}`,
              subnetwork: Output.interpolate`regions/${network.region}/subnetworks/${network.subnetwork}`,
              associatePublicIp: true,
              tags: [network.tag],
              serviceAccount: account.email,
              oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
              metadata: metadata as unknown as Record<string, string>,
            }),
          );
        }
        const health = yield* Compute.HttpHealthCheck(`${id}GatewayHealth`, {
          port: GATEWAY_PORT,
          requestPath: "/health",
        });
        const pool = yield* Compute.TargetPool(`${id}Gateway`, {
          region: network.region,
          healthChecks: [health.selfLink as Output.Output<string>],
          instances: instances.map((instance) => instance.selfLink as Output.Output<string>),
        });
        yield* Compute.ForwardingRule(`${id}GatewayRule`, {
          region: network.region,
          ipAddress: gateway.address,
          ipProtocol: "TCP",
          portRange: String(GATEWAY_PORT),
          target: pool.selfLink as Output.Output<string>,
          loadBalancingScheme: "EXTERNAL",
        });
      }),
  });
