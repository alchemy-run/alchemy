import * as Neon from "@alchemy.run/neon";
import * as hyperdrive from "@distilled.cloud/cloudflare/hyperdrive";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { assert, expect } from "alchemy-test";
import * as Cloudflare from "alchemy/Cloudflare";
import { CloudflareEnvironment } from "alchemy/Cloudflare";
import { findZoneByName } from "alchemy/Cloudflare/Zone";
import * as Provider from "alchemy/Provider";
import * as Test from "alchemy/Test/Alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";
import HyperdriveAccessEffectWorker from "./fixtures/access-effect-worker.ts";
import {
  ACCESS_ORIGIN_HOST,
  ACCESS_ORIGIN_PASSWORD,
  ACCESS_ORIGIN_PORT,
  ACCESS_ORIGIN_ZONE,
  AccessOriginConnection,
  AccessOriginRoute,
} from "./fixtures/access-origin.ts";
import { outOfBandConfig } from "./fixtures/lookup-config.ts";
import HyperdriveLookupEffectWorker from "./fixtures/lookup-effect-worker.ts";
import { lookupConfigName } from "./fixtures/lookup.ts";
import HyperdriveVpcEffectWorker from "./fixtures/vpc-effect-worker.ts";
import {
  VPC_ORIGIN_PASSWORD,
  VPC_ORIGIN_PORT,
  VpcOriginConnection,
  VpcOriginService,
  VpcOriginTunnel,
} from "./fixtures/vpc-origin.ts";

const { test } = Test.make({ providers: Layer.merge(Cloudflare.providers(), Neon.providers()) });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");
test.provider(
  "create and delete hyperdrive with default props",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const { db, hd } = yield* stack.deploy(
        Effect.gen(function* () {
          const db = yield* Neon.Project("DefaultProject");
          const hd = yield* Cloudflare.Hyperdrive.Connection("DefaultHyperdrive", {
            origin: db.origin,
          });
          return { db, hd };
        }),
      );

      expect(hd.hyperdriveId).toBeDefined();
      expect(hd.name).toBeDefined();

      const actual = yield* hyperdrive.getConfig({ accountId, hyperdriveId: hd.hyperdriveId });
      expect(actual.id).toEqual(hd.hyperdriveId);
      assert("host" in actual.origin, "db.origin must have a host");
      expect(actual.origin.host).toEqual(db.origin.host);

      yield* stack.destroy();

      yield* waitForConfigToBeDeleted(hd.hyperdriveId, accountId);
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:hyperdrive",
      "provider:neon",
      "provider:neon:project",
      "live",
    ],
  },
);

test.provider(
  "create, update, delete hyperdrive",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const hd = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Neon.Project("CRUDProject");
          return yield* Cloudflare.Hyperdrive.Connection("CRUDHyperdrive", {
            origin: project.origin,
            caching: { disabled: false, maxAge: 60 },
          });
        }),
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Neon.Project("CRUDProject");
          return yield* Cloudflare.Hyperdrive.Connection("CRUDHyperdrive", {
            origin: project.origin,
            caching: { disabled: true },
          });
        }),
      );

      expect(updated.hyperdriveId).toEqual(hd.hyperdriveId);

      const actual = yield* hyperdrive.getConfig({ accountId, hyperdriveId: updated.hyperdriveId });
      // After PUT with `disabled: true`, caching should reflect the change.
      expect(actual.caching).toBeDefined();

      yield* stack.destroy();

      yield* waitForConfigToBeDeleted(hd.hyperdriveId, accountId);
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:hyperdrive",
      "provider:neon",
      "provider:neon:project",
      "live",
    ],
  },
);

test.provider(
  "list enumerates the deployed hyperdrive",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const hd = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Neon.Project("ListProject");
          return yield* Cloudflare.Hyperdrive.Connection("ListHyperdrive", {
            origin: project.origin,
          });
        }),
      );

      const provider = yield* Provider.findProvider(Cloudflare.Hyperdrive.Connection);
      const all = yield* provider.list();

      expect(all.some((x) => x.hyperdriveId === hd.hyperdriveId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:hyperdrive",
      "provider:neon",
      "provider:neon:project",
      "live",
    ],
  },
);

// ── Existing configuration (#1343) ─────────────────────────────────────────
// `Hyperdrive.lookup` binds a configuration the stack does not own: deploys
// only read it and destroy leaves it untouched.

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {}

/** GET `${base}/meta`, riding out fresh workers.dev cold-start 404s. */
const getMeta = (base: string) =>
  HttpClient.get(`${base}/meta`).pipe(
    Effect.flatMap((res) =>
      res.text.pipe(
        Effect.flatMap((body) =>
          res.status === 200
            ? Effect.succeed(JSON.parse(body) as { database: string; hasConnectionString: boolean })
            : Effect.fail(new WorkerNotReady({ status: res.status, body })),
        ),
      ),
    ),
    Effect.retry({
      while: (e) => e._tag === "WorkerNotReady",
      schedule: Schedule.spaced("2 seconds"),
      times: 30,
    }),
  );

test.provider(
  "lookup binds an existing configuration without managing it",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const { origin } = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Neon.Project("LookupProject");
          return { origin: project.origin };
        }),
      );

      const deployed = yield* Effect.scoped(
        Effect.gen(function* () {
          const created = yield* outOfBandConfig(accountId, lookupConfigName("live"), origin);

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              yield* Neon.Project("LookupProject");
              // By name, through `Cloudflare.Hyperdrive.Connect`.
              const effectWorker = yield* HyperdriveLookupEffectWorker;
              // By id, through `env`.
              const asyncWorker = yield* Cloudflare.Worker("HyperdriveLookupAsyncWorker", {
                main: pathe.resolve(import.meta.dirname, "fixtures/async-worker.ts"),
                env: {
                  HD: Cloudflare.Hyperdrive.lookup("HyperdriveLookupById", {
                    hyperdriveId: created.id,
                  }),
                },
              });
              return { effectWorker, asyncWorker };
            }),
          );

          // Both binding flavors are bound to the looked-up configuration —
          // the runtime binding reports the configuration id as its database.
          for (const url of [deployed.effectWorker.url!, deployed.asyncWorker.url!]) {
            const meta = yield* getMeta(url);
            expect(meta.database).toEqual(created.id);
            expect(meta.hasConnectionString).toBe(true);
          }

          yield* stack.destroy();

          // Neither the deploy nor the destroy touched the configuration.
          const survived = yield* hyperdrive.getConfig({ accountId, hyperdriveId: created.id });
          expect(survived.id).toEqual(created.id);
          expect(survived.modifiedOn).toEqual(created.modifiedOn);
          return deployed;
        }),
      );

      yield* waitForWorkerToBeDeleted(deployed.effectWorker.workerName, accountId);
      yield* waitForWorkerToBeDeleted(deployed.asyncWorker.workerName, accountId);
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:hyperdrive",
      "provider:cloudflare:worker",
      "provider:neon",
      "provider:neon:project",
      "live",
    ],
    timeout: 240_000,
  },
);

// ── Access-protected origin (#1836) ────────────────────────────────────────
// A real origin behind Cloudflare Access: Postgres in Docker, published
// through a Cloudflare Tunnel whose connector (`cloudflared`) runs here,
// guarded by a self-hosted Access app that admits one service token. Both
// binding flavors bind the Connection with no `dev` override and must
// deploy and query through it.

const cloudflaredBin = Bun.which("cloudflared");
const dockerBin = Bun.which("docker");
const ACCESS_ORIGIN_CONTAINER = "alchemy-test-hyperdrive-access-origin";

const run = (cmd: string[]) =>
  Effect.sync(() => Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" }));

/** Postgres with TLS (the image's snakeoil cert) on `127.0.0.1:${port}`, removed when the scope closes. */
const localPostgres = (container: string, port: number, password: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      yield* run([dockerBin!, "rm", "-f", container]);
      const started = yield* run([
        dockerBin!,
        "run",
        "-d",
        "--rm",
        "--name",
        container,
        "-e",
        `POSTGRES_PASSWORD=${password}`,
        "-p",
        `127.0.0.1:${port}:5432`,
        "postgres:17",
        "-c",
        "ssl=on",
        "-c",
        "ssl_cert_file=/etc/ssl/certs/ssl-cert-snakeoil.pem",
        "-c",
        "ssl_key_file=/etc/ssl/private/ssl-cert-snakeoil.key",
      ]);
      if (started.exitCode !== 0) {
        return yield* Effect.die(new Error(`docker run failed: ${started.stderr.toString()}`));
      }
      yield* run([
        dockerBin!,
        "exec",
        container,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
      ]).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (result) => result.exitCode === 0,
          times: 30,
        }),
      );
    }),
    () => run([dockerBin!, "rm", "-f", container]),
  );

const accessOriginPostgres = localPostgres(
  ACCESS_ORIGIN_CONTAINER,
  ACCESS_ORIGIN_PORT,
  ACCESS_ORIGIN_PASSWORD,
);

class TunnelNotHealthy extends Data.TaggedError("TunnelNotHealthy")<{ status: string }> {}
class OriginQueryFailed extends Data.TaggedError("OriginQueryFailed")<{
  status: number;
  body: string;
}> {}

/** Run the tunnel's connector here until the scope closes, then wait for it to register. */
const tunnelConnector = (accountId: string, tunnelId: string, token: string) =>
  Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.spawn([cloudflaredBin!, "tunnel", "run", "--token", token], {
          stdout: "ignore",
          stderr: "ignore",
        }),
      ),
      (proc) =>
        Effect.promise(async () => {
          proc.kill();
          await proc.exited;
        }),
    );
    yield* zeroTrust.getTunnelCloudflared({ accountId, tunnelId }).pipe(
      Effect.flatMap((tunnel) =>
        tunnel.status === "healthy"
          ? Effect.void
          : Effect.fail(new TunnelNotHealthy({ status: String(tunnel.status) })),
      ),
      Effect.retry({
        while: (e) => e._tag === "TunnelNotHealthy",
        schedule: Schedule.spaced("2 seconds"),
        times: 30,
      }),
    );
  });

const queryThroughOrigin = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((res) =>
      res.text.pipe(
        Effect.flatMap((body) =>
          res.status === 200
            ? Effect.succeed(JSON.parse(body) as { via: string })
            : Effect.fail(new OriginQueryFailed({ status: res.status, body })),
        ),
      ),
    ),
    Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 20 }),
  );

test.provider.skipIf(!cloudflaredBin || !dockerBin)(
  "deploys and queries an Access-protected origin without a dev override",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zone = yield* findZoneByName({ accountId, name: ACCESS_ORIGIN_ZONE });
      if (!zone) return yield* Effect.die(new Error(`zone ${ACCESS_ORIGIN_ZONE} not found`));

      yield* stack.destroy();

      const deployed = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* accessOriginPostgres;

          // The tunnel must have a live connector before Hyperdrive is
          // created: Cloudflare connects to the origin when it creates it.
          const route = yield* stack.deploy(AccessOriginRoute(zone.id));
          yield* tunnelConnector(
            accountId,
            route.tunnel.tunnelId,
            Redacted.value(route.tunnel.token),
          );

          const deployed = yield* stack
            .deploy(
              Effect.gen(function* () {
                yield* AccessOriginRoute(zone.id);
                const connection = yield* AccessOriginConnection;
                const effectWorker = yield* HyperdriveAccessEffectWorker;
                const asyncWorker = yield* Cloudflare.Worker("HyperdriveAccessAsyncWorker", {
                  main: pathe.resolve(import.meta.dirname, "fixtures/access-async-worker.ts"),
                  env: { HD: AccessOriginConnection },
                });
                return { connection, effectWorker, asyncWorker };
              }),
            )
            .pipe(
              // Hyperdrive resolves the origin host when it creates the config,
              // and a just-created CNAME can take a little while to answer.
              Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 12 }),
            );

          const actual = yield* hyperdrive.getConfig({
            accountId,
            hyperdriveId: deployed.connection.hyperdriveId,
          });
          assert("accessClientId" in actual.origin, "origin must be Access-protected");
          expect(actual.origin.host).toEqual(ACCESS_ORIGIN_HOST);

          // Both binding flavors reach Postgres through Access + the tunnel.
          expect(yield* queryThroughOrigin(deployed.effectWorker.url!)).toEqual({
            via: "through-access",
          });
          expect(yield* queryThroughOrigin(deployed.asyncWorker.url!)).toEqual({
            via: "through-access",
          });
          return deployed;
        }),
      );

      yield* stack.destroy();
      yield* waitForConfigToBeDeleted(deployed.connection.hyperdriveId, accountId);
      yield* waitForWorkerToBeDeleted(deployed.effectWorker.workerName, accountId);
      yield* waitForWorkerToBeDeleted(deployed.asyncWorker.workerName, accountId);
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:hyperdrive",
      "provider:cloudflare:tunnel",
      "provider:cloudflare:access",
      "live",
    ],
    timeout: 300_000,
  },
);

// ── Workers VPC origin ──────────────────────────────────────────────────────
// A private origin reached through Workers VPC: Postgres in Docker, exposed
// as a TCP VPC Service over a Cloudflare Tunnel whose connector
// (`cloudflared`) runs here — the same topology as an Aurora/RDS instance
// inside an AWS VPC with `cloudflared` running in the VPC. Both binding
// flavors must query through it.

const VPC_ORIGIN_CONTAINER = "alchemy-test-hyperdrive-vpc-origin";

test.provider.skipIf(!cloudflaredBin || !dockerBin)(
  "deploys and queries a private origin through a Workers VPC Service",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const deployed = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* localPostgres(VPC_ORIGIN_CONTAINER, VPC_ORIGIN_PORT, VPC_ORIGIN_PASSWORD);

          // The tunnel must have a live connector before Hyperdrive is
          // created: Cloudflare connects to the origin when it creates it.
          const tunnel = yield* stack.deploy(VpcOriginTunnel);
          yield* tunnelConnector(accountId, tunnel.tunnelId, Redacted.value(tunnel.token));

          // The VPC Service is created in the same deploy as Hyperdrive, so
          // Hyperdrive's create must ride out the service's propagation.
          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              yield* VpcOriginTunnel;
              const service = yield* VpcOriginService;
              const connection = yield* VpcOriginConnection;
              const effectWorker = yield* HyperdriveVpcEffectWorker;
              const asyncWorker = yield* Cloudflare.Worker("HyperdriveVpcAsyncWorker", {
                main: pathe.resolve(import.meta.dirname, "fixtures/vpc-async-worker.ts"),
                env: { HD: VpcOriginConnection },
              });
              return { service, connection, effectWorker, asyncWorker };
            }),
          );

          const actual = yield* hyperdrive.getConfig({
            accountId,
            hyperdriveId: deployed.connection.hyperdriveId,
          });
          assert("serviceId" in actual.origin, "origin must be a VPC Service origin");
          expect(actual.origin.serviceId).toEqual(deployed.service.serviceId);
          expect(actual.origin.database).toEqual("postgres");

          // Both binding flavors reach Postgres through the VPC Service.
          expect(yield* queryThroughOrigin(deployed.effectWorker.url!)).toEqual({
            via: "through-vpc",
          });
          expect(yield* queryThroughOrigin(deployed.asyncWorker.url!)).toEqual({
            via: "through-vpc",
          });
          return deployed;
        }),
      );

      yield* stack.destroy();
      yield* waitForConfigToBeDeleted(deployed.connection.hyperdriveId, accountId);
      yield* waitForWorkerToBeDeleted(deployed.effectWorker.workerName, accountId);
      yield* waitForWorkerToBeDeleted(deployed.asyncWorker.workerName, accountId);
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:hyperdrive",
      "provider:cloudflare:tunnel",
      "provider:cloudflare:connectivity",
      "live",
    ],
    timeout: 300_000,
  },
);

const waitForConfigToBeDeleted = Effect.fn(function* (hyperdriveId: string, accountId: string) {
  yield* hyperdrive.getConfig({ accountId, hyperdriveId }).pipe(
    Effect.flatMap(() => Effect.fail(new ConfigStillExists())),
    Effect.retry({
      while: (e): e is ConfigStillExists => e instanceof ConfigStillExists,
      schedule: Schedule.exponential(100),
    }),
    Effect.catchTag("HyperdriveConfigNotFound", () => Effect.void),
  );
});

class ConfigStillExists extends Data.TaggedError("ConfigStillExists") {}
