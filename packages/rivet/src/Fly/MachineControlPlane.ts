import * as Fly from "@alchemy.run/fly";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Cluster } from "../Cluster.ts";
import { adminToken } from "../internal/AdminToken.ts";
import { Namespace } from "../Namespace.ts";

/** The engine release `RivetFly.MachineControlPlane` runs by default. */
export const DEFAULT_ENGINE_IMAGE = "rivetdev/engine:3.0.0";

const DATA_PATH = "/var/lib/rivet";
const API_PORT = 6420;
const PEER_PORT = 6421;

export interface MachineControlPlaneProps {
  /**
   * Number of engines, one Machine each with a volume of its own. Run 3 or
   * more in production.
   * @default 3
   */
  instances?: number;
  /**
   * Fly region of the Machines.
   * @default "iad"
   */
  region?: string;
  /**
   * Machine size of each engine.
   * @default { cpus: 2, memoryMb: 4096 }
   */
  guest?: Fly.MachineGuest;
  /**
   * Size of each engine's volume, in GB.
   * @default 10
   */
  diskSize?: number;
  /**
   * Engine image.
   * @default "rivetdev/engine:3.0.0"
   */
  image?: string;
}

/**
 * Run the engine with this Machine's private address as its peer address:
 * Machines in an App reach each other over Fly's private IPv6 network.
 */
const ENTRYPOINT = [
  "/bin/sh",
  "-c",
  `export RIVET__API_PEER__ADVERTISE_ADDRESS="[$FLY_PRIVATE_IP]:${PEER_PORT}"; exec /usr/bin/rivet-engine`,
];

/**
 * A Rivet control plane on Fly.io, as a `Rivet.Cluster` Layer: an App of
 * engine Machines, each with a volume of its own, a Tigris bucket for the
 * durable copy of every actor's data, and the App's public
 * `https://{app}.fly.dev` address in front. Engines find each other through
 * the bucket and talk over the App's private network. A namespace is
 * created for the stage.
 *
 * Pools of nodes anywhere reach it at its public address —
 * `RivetFly.MachinePool` on Fly, or a pool on any other cloud.
 *
 * ### Running a control plane on Fly
 * **Example:** Three engines in Ashburn
 * ```typescript
 * export const Cluster = RivetFly.MachineControlPlane("Rivet");
 * ```
 *
 * **Example:** Larger engines in Frankfurt
 * ```typescript
 * export const Cluster = RivetFly.MachineControlPlane("Rivet", {
 *   region: "fra",
 *   guest: { cpus: 4, memoryMb: 8192 },
 *   diskSize: 50,
 * });
 * ```
 *
 * @primitive
 */
export const MachineControlPlane = (id: string, props: MachineControlPlaneProps = {}) =>
  Layer.effect(
    Cluster,
    Effect.gen(function* () {
      if (globalThis.__ALCHEMY_RUNTIME__) {
        // Nodes and callers read their endpoint and token from their own
        // environment at runtime; the cluster is only consulted while deploying.
        return { endpoint: "", token: Redacted.make(""), namespace: "default" };
      }
      const instances = props.instances ?? 3;
      const token = yield* adminToken(id);
      const bucket = yield* Fly.Bucket(`${id}Data`, {});
      const app = yield* Fly.App(`${id}App`, {});
      yield* Fly.IpAssignment(`${id}PublicV4`, { app, type: "shared_v4" });
      yield* Fly.IpAssignment(`${id}PublicV6`, { app, type: "v6" });

      // Machine environment values are plain strings.
      const env = Output.all(
        token.text,
        bucket.bucketName,
        bucket.endpoint,
        bucket.region,
        bucket.accessKeyId,
        bucket.secretAccessKey,
      ).pipe(
        Output.map(([text, name, endpoint, region, keyId, secret]) => ({
          RIVET__AUTH__ADMIN_TOKEN: Redacted.value(text),
          RIVET__STORAGE__LOG_DIRECTORY: DATA_PATH,
          RIVET__OBJECT_STORAGE__PRIMARY__S3__BUCKET: name ? Redacted.value(name) : "",
          RIVET__OBJECT_STORAGE__PRIMARY__S3__ENDPOINT: endpoint ? Redacted.value(endpoint) : "",
          RIVET__OBJECT_STORAGE__PRIMARY__S3__REGION: region ? Redacted.value(region) : "auto",
          RIVET__OBJECT_STORAGE__PRIMARY__S3__ACCESS_KEY_ID: keyId ? Redacted.value(keyId) : "",
          RIVET__OBJECT_STORAGE__PRIMARY__S3__SECRET_ACCESS_KEY: secret
            ? Redacted.value(secret)
            : "",
          // The private network is IPv6: listen for peers on it.
          RIVET__API_PEER__HOST: "::",
          RIVET__TELEMETRY__ENABLED: "false",
        })),
      );

      const engines = [];
      for (let i = 0; i < instances; i++) {
        engines.push(
          yield* Fly.Machine(`${id}Engine${i}`, {
            app,
            region: props.region ?? "iad",
            image: props.image ?? "rivetdev/engine:3.0.0",
            init: { entrypoint: ENTRYPOINT },
            guest: props.guest ?? { cpus: 2, memoryMb: 4096 },
            mounts: [{ path: DATA_PATH, sizeGb: props.diskSize ?? 10 }],
            env,
            restart: { policy: "always" },
            services: [
              {
                protocol: "tcp",
                internalPort: API_PORT,
                // Engines run all the time: nodes hold connections to them.
                autostart: true,
                autostop: "off",
                ports: [
                  { port: 443, handlers: ["tls", "http"] },
                  { port: 80, handlers: ["http"] },
                ],
                checks: [{ type: "http", port: API_PORT, path: "/health", interval: "10s" }],
              },
            ],
          }),
        );
      }

      const endpoint = app.url;
      const namespace = yield* Namespace(`${id}Namespace`, {
        // Created through the API the engines serve, once they all run.
        endpoint: Output.all(
          endpoint,
          Output.all(...engines.map((engine) => engine.machineId)),
        ).pipe(Output.map(([url]) => url)),
        token: token.text,
      });
      return { endpoint, token: token.text, namespace: namespace.name };
    }),
  );
