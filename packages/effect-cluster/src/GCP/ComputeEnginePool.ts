import * as Compute from "@alchemy.run/gcp/Compute";
import * as IAM from "@alchemy.run/gcp/IAM";
import * as Storage from "@alchemy.run/gcp/Storage";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { GATEWAY_PORT, RUNNER_PORT } from "../internal/Gateway.ts";
import { makePoolLayer, type PoolSettings } from "../internal/PoolHost.ts";
import { COS_IMAGE } from "./Database.ts";

const NODE_IMAGE = "node:26-slim";
const APP_PATH = "/var/lib/cluster-runner";
const ENV_KEY = "cluster-runner-env";
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
}

/**
 * Fetch the runner program from the bucket and run it on the host network.
 * When the instance's metadata changes (a new program, new environment), run
 * this script again, so every runner picks the change up.
 */
const startupScript = (options: { readonly bucket: string }) => `#!/bin/bash
set -uo pipefail
MD=http://metadata.google.internal/computeMetadata/v1
mkdir -p ${APP_PATH}
# Container-Optimized OS drops inbound traffic except SSH: open the runner's ports.
for PORT in ${RUNNER_PORT} ${GATEWAY_PORT}; do
  iptables -C INPUT -p tcp --dport $PORT -j ACCEPT 2>/dev/null || iptables -A INPUT -p tcp --dport $PORT -j ACCEPT
done
fetch() {
  TOKEN="$(curl -sf -H 'Metadata-Flavor: Google' "$MD/instance/service-accounts/default/token" | sed -E 's/.*"access_token":"([^"]+)".*/\\1/')"
  curl -sf -H "Authorization: Bearer $TOKEN" -o ${APP_PATH}/$1.next \\
    "https://storage.googleapis.com/storage/v1/b/${options.bucket}/o/$1?alt=media" \\
    && mv ${APP_PATH}/$1.next ${APP_PATH}/$1
}
start() {
  fetch runner.mjs
  curl -sf -H 'Metadata-Flavor: Google' "$MD/instance/attributes/${ENV_KEY}" > ${APP_PATH}/env.list
  docker rm -f cluster-runner >/dev/null 2>&1 || true
  docker run -d --name cluster-runner --restart always --network host \\
    --env-file ${APP_PATH}/env.list -v ${APP_PATH}:/app:ro -w /app ${NODE_IMAGE} node /app/runner.mjs
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
 * Requires a database on a GCP network — `ClusterGCP.Database`.
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
    network: (database) => (database.network?.kind === "gcp" ? database.network : undefined),
    // A static address, before the instances, so the URL never depends on it.
    gateway: (_name, network) =>
      Effect.gen(function* () {
        const address = yield* Compute.Address(`${id}GatewayAddress`, { region: network.region });
        return {
          url: Output.interpolate`http://${address.address}:${GATEWAY_PORT}`,
          address: address.address as Output.Output<string>,
        };
      }),
    nodes: ({ network, gateway, program, environment }) =>
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
        // A Docker env file: one `NAME=value` per line. Each runner finds its
        // own address in the subnetwork's range.
        const envFile = environment.pipe(
          Output.map((env) =>
            Object.entries({ ...env, CLUSTER_RUNNER_NETWORK: network.cidr })
              .map(([name, value]) => `${name}=${String(value).replaceAll("\n", " ")}`)
              .join("\n"),
          ),
        );
        const metadata = Output.all(bucket.bucketName, runner.md5Hash, envFile, grant.role).pipe(
          Output.map(([bucketName, hash, env]) => ({
            "startup-script": startupScript({ bucket: bucketName }),
            [HASH_KEY]: hash ?? "",
            [ENV_KEY]: env,
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
