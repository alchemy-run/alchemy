/**
 * A control plane the stack runs itself, given to `Rivet.ControlPlane` with
 * a private address: one engine on the project's `default` network, reached
 * by callers at its public address and by nodes on the network at its
 * private one. The pools join `default`, which outlives the stack, so Cloud
 * Run holding a subnetwork's addresses after a worker pool is deleted never
 * blocks the destroy.
 */
import * as Compute from "@alchemy.run/gcp/Compute";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import * as IAM from "@alchemy.run/gcp/IAM";
import * as SecretManager from "@alchemy.run/gcp/SecretManager";
import * as Rivet from "@alchemy.run/rivet";
import * as RivetGCP from "@alchemy.run/rivet/GCP";
import { DEFAULT_ENGINE_IMAGE } from "@alchemy.run/rivet/GCP/ComputeEngineControlPlane";
import * as Output from "alchemy/Output";
import { Random } from "alchemy/Random";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const API_PORT = 6420;
const DATA = "/mnt/stateful_partition/rivet";

/** Read the admin token from Secret Manager as the instance's account, then run the engine. */
const startupScript = (tokenVersion: string) => `#!/bin/bash
set -euo pipefail
MD=http://metadata.google.internal/computeMetadata/v1
for ATTEMPT in $(seq 1 60); do
  ACCESS="$(curl -sf -H 'Metadata-Flavor: Google' "$MD/instance/service-accounts/default/token" | sed -E 's/.*"access_token":"([^"]+)".*/\\1/')" \\
    && BODY="$(curl -sf -H "Authorization: Bearer $ACCESS" "https://secretmanager.googleapis.com/v1/${tokenVersion}:access")" \\
    && break
  sleep 5
done
export RIVET__AUTH__ADMIN_TOKEN="$(printf '%s' "$BODY" | tr -d '\\n' | sed -E 's/.*"data": *"([^"]*)".*/\\1/' | base64 -d)"
iptables -C INPUT -p tcp --dport ${API_PORT} -j ACCEPT 2>/dev/null || iptables -A INPUT -p tcp --dport ${API_PORT} -j ACCEPT
mkdir -p ${DATA}
docker rm -f rivet-engine >/dev/null 2>&1 || true
docker run -d --name rivet-engine --restart always --network host \\
  -v ${DATA}:/var/lib/rivet \\
  -e RIVET__AUTH__ADMIN_TOKEN \\
  -e RIVET__STORAGE__LOG_DIRECTORY=/var/lib/rivet \\
  -e RIVET__STORAGE__AUTO_PROVISION_PARTITIONS=true \\
  -e RIVET__OBJECT_STORAGE__PRIMARY__FILE_SYSTEM__PATH=/var/lib/rivet/objects \\
  -e RIVET__TELEMETRY__ENABLED=false \\
  '${DEFAULT_ENGINE_IMAGE}'
`;

export const PrivateCluster = Layer.unwrap(
  Effect.gen(function* () {
    const { region } = yield* GcpEnvironment.current.pipe(Effect.orDie);
    const { stage } = yield* Stack;
    // A network tag of this stage's own: `default` is shared by every stage.
    const tag = `rivet-private-${stage.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(0, 63);
    const token = yield* Random("PrivateEngineToken", { bytes: 32 });
    const secret = yield* SecretManager.Secret("PrivateEngineToken", { value: token.text });
    const account = yield* IAM.ServiceAccount("PrivateEngineAccount", {
      displayName: "Rivet private engine",
    });
    const grant = yield* IAM.Member("PrivateEngineTokenGrant", {
      kind: "secretmanager.secret",
      name: secret.name,
      role: "roles/secretmanager.secretAccessor",
      member: Output.interpolate`serviceAccount:${account.email}`,
    });
    // Callers anywhere reach the API with the token; nodes on `default` reach it privately.
    yield* Compute.Firewall("PrivateEngineApi", {
      network: "default",
      direction: "INGRESS",
      allowed: [{ protocol: "tcp", ports: [String(API_PORT)] }],
      sourceRanges: ["0.0.0.0/0"],
      targetTags: [tag],
    });
    const engine = yield* Compute.Instance("PrivateEngine", {
      zone: `${region}-a`,
      machineType: "e2-standard-2",
      sourceImage: "projects/cos-cloud/global/images/family/cos-stable",
      network: "global/networks/default",
      subnetwork: `regions/${region}/subnetworks/default`,
      associatePublicIp: true,
      tags: [tag],
      serviceAccount: account.email,
      oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
      metadata: {
        "startup-script": Output.all(secret.version, grant.role).pipe(
          Output.map(([version]) => startupScript(version ?? "")),
        ),
      },
    });
    return Rivet.ControlPlane("Private", {
      endpoint: Output.interpolate`http://${engine.natIP}:${API_PORT}`,
      token: token.text,
      nodeEndpoint: Output.interpolate`http://${engine.networkIP}:${API_PORT}`,
      network: { kind: "gcp", network: "default", subnetwork: "default", region },
    });
  }),
);

/** Nodes on the control plane's network, which connect to its private address. */
export const PrivatePool = RivetGCP.CloudRunPool("Private");
/** Nodes on no network of the control plane's, which connect to its public address. */
export const PrivateServices = RivetGCP.ServicesPool("PrivateServices");
