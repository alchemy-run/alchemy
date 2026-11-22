import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as Render from "@alchemy.run/render";
import { stripSslQueryParams } from "@alchemy.run/sql/PostgresDriver";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Provider from "alchemy/Provider";
import { type BaseRuntimeContext, RuntimeContext } from "alchemy/RuntimeContext";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import pg from "pg";

const skipLive = !process.env.RENDER_API_KEY || process.env.RENDER_LIVE_TESTS !== "1";

const liveProviders = Layer.merge(
  Render.providers(),
  Layer.succeed(Render.RenderPollConfig, {
    intervalMs: 4_000,
    maxAttempts: 45,
  }),
);

const withRuntimeFlag = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = (globalThis as { __ALCHEMY_RUNTIME__?: boolean }).__ALCHEMY_RUNTIME__;
      (globalThis as { __ALCHEMY_RUNTIME__?: boolean }).__ALCHEMY_RUNTIME__ = true;
      return prev;
    }),
    () => effect,
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) {
          delete (globalThis as { __ALCHEMY_RUNTIME__?: boolean }).__ALCHEMY_RUNTIME__;
        } else {
          (globalThis as { __ALCHEMY_RUNTIME__?: boolean }).__ALCHEMY_RUNTIME__ = prev;
        }
      }),
  );

const makeMemoryRuntimeContext = (env: Record<string, string | Redacted.Redacted<string>> = {}) => {
  const stored = new Map<string, unknown>(Object.entries(env));
  const service: BaseRuntimeContext = {
    Type: "Render.LiveTestRunner",
    id: "render-live-test-runner",
    env: Object.fromEntries(Object.entries(env)),
    get: <T>(key: string) => Effect.succeed(stored.get(key) as T | undefined),
    set: (id: string, value: unknown) =>
      Effect.sync(() => {
        stored.set(id, value);
        service.env[id] = value as string | Redacted.Redacted<string>;
        return id;
      }),
  };
  return Layer.succeed(RuntimeContext, service);
};

describe("Render Live API", { tags: ["provider:render", "live"], timeout: 240_000 }, () => {
  const t = Test.make({ providers: liveProviders });

  t.test.provider.skipIf(skipLive)(
    "reconciles Project, Environment, RegistryCredential, EnvGroup, and Webhook with noop drift check and zero leaks",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const projectProv = yield* Provider.findProvider(Render.Project);
        const envProv = yield* Provider.findProvider(Render.Environment);
        const credProv = yield* Provider.findProvider(Render.RegistryCredential);
        const groupProv = yield* Provider.findProvider(Render.EnvGroup);
        const hookProv = yield* Provider.findProvider(Render.Webhook);
        const ipProv = yield* Provider.findProvider(Render.DedicatedIp);
        const redisProv = yield* Provider.findProvider(Render.Redis);
        const logProv = yield* Provider.findProvider(Render.LogStream);
        const metricsProv = yield* Provider.findProvider(Render.MetricsStream);
        const notifyProv = yield* Provider.findProvider(Render.NotificationSetting);
        const wfProv = yield* Provider.findProvider(Render.Workflow);
        const bpProv = yield* Provider.findProvider(Render.Blueprint);

        // Record baseline workspace counts + exercise read-only singleton/list endpoints
        const baseCounts = {
          projects: (yield* projectProv.list!()).length,
          environments: (yield* envProv.list!()).length,
          creds: (yield* credProv.list!()).length,
          groups: (yield* groupProv.list!()).length,
          hooks: (yield* hookProv.list!()).length,
        };
        yield* ipProv.list!();
        yield* redisProv.list!();
        yield* wfProv.list!();
        yield* bpProv.list!();
        const validated = yield* Render.validateBlueprint({
          yaml: [
            "services:",
            "  - type: web",
            "    name: alchemy-validate-probe",
            "    runtime: node",
            "    buildCommand: npm install",
            "    startCommand: node index.js",
            "",
          ].join("\n"),
        });
        expect(validated.valid).not.toBe(false);
        yield* logProv.lookup!({});
        yield* metricsProv.lookup!({});
        const notify = yield* notifyProv.lookup!({});
        expect(notify?.ownerId).toBeDefined();

        const program = (version: "v1" | "v2") =>
          Effect.gen(function* () {
            const proj = yield* Render.Project("LiveCoreProject", {
              environments: {
                staging: { name: "staging", protectedStatus: "unprotected" },
              },
            });
            const extraEnv = yield* Render.Environment("LiveStandaloneEnv", {
              projectId: proj.id,
              name: version === "v1" ? "qa-live" : "qa-live-v2",
              protectedStatus: "unprotected",
            });
            const cred = yield* Render.RegistryCredential("LiveRegCred", {
              registry: "DOCKER",
              username: "alchemy-live-bot",
              authToken: Redacted.make(`dckr_pat_live_${version}`),
            });
            const group = yield* Render.EnvGroup("LiveCoreEnvGroup", {
              environmentId: proj.environments.staging.id,
              envVars: {
                ALCHEMY_LIVE_TEST: version,
                GENERATED_TOKEN: { generateValue: true },
              },
              secretFiles: {
                "live.json": JSON.stringify({ version }),
              },
            });
            const hook = yield* Render.Webhook("LiveCoreWebhook", {
              url: `https://example.com/alchemy-render-webhook-${version}`,
              enabled: version === "v2",
              eventFilter: version === "v1" ? ["deploy_ended"] : ["deploy_ended", "build_ended"],
            });
            return { proj, extraEnv, cred, group, hook };
          });

        const deployed = yield* stack.deploy(program("v1"));
        expect(deployed.proj.id).toBeDefined();
        expect(deployed.extraEnv.projectId).toBe(deployed.proj.id);
        expect(deployed.cred.registry).toBe("DOCKER");
        expect(Redacted.value(deployed.group.envVars.ALCHEMY_LIVE_TEST)).toBe("v1");
        const initialGenerated = Redacted.value(deployed.group.envVars.GENERATED_TOKEN);
        expect(initialGenerated.length).toBeGreaterThan(0);
        expect(deployed.hook.enabled).toBe(false);

        // Verify immediate re-plan with identical props is noop across all 5 resources
        const noopPlan = yield* stack.plan(program("v1"));
        expect(
          Object.fromEntries(Object.entries(noopPlan.resources).map(([k, v]) => [k, v?.action])),
        ).toEqual({
          LiveCoreProject: "noop",
          LiveStandaloneEnv: "noop",
          LiveRegCred: "noop",
          LiveCoreEnvGroup: "noop",
          LiveCoreWebhook: "noop",
        });

        // Verify real API lookup() and list() decoding for all 5 resources
        expect((yield* projectProv.lookup!({ name: deployed.proj.name }))?.id).toBe(
          deployed.proj.id,
        );
        expect((yield* envProv.lookup!({ projectId: deployed.proj.id, name: "qa-live" }))?.id).toBe(
          deployed.extraEnv.id,
        );
        expect((yield* credProv.lookup!({ name: deployed.cred.name }))?.id).toBe(deployed.cred.id);
        expect((yield* groupProv.lookup!({ name: deployed.group.name }))?.id).toBe(
          deployed.group.id,
        );
        expect((yield* hookProv.lookup!({ name: deployed.hook.name }))?.id).toBe(deployed.hook.id);

        // Update pass: preserves generated secret value while updating plain vars, secret file, webhook, env, cred
        const updated = yield* stack.deploy(program("v2"));
        expect(updated.extraEnv.id).toBe(deployed.extraEnv.id);
        expect(updated.extraEnv.name).toBe("qa-live-v2");
        expect(updated.cred.id).toBe(deployed.cred.id);
        expect(updated.group.id).toBe(deployed.group.id);
        expect(Redacted.value(updated.group.envVars.ALCHEMY_LIVE_TEST)).toBe("v2");
        expect(Redacted.value(updated.group.envVars.GENERATED_TOKEN)).toBe(initialGenerated);
        expect(updated.hook.id).toBe(deployed.hook.id);
        expect(updated.hook.enabled).toBe(true);

        yield* stack.destroy();
        expect((yield* projectProv.list!()).length).toBe(baseCounts.projects);
        expect((yield* envProv.list!()).length).toBe(baseCounts.environments);
        expect((yield* credProv.list!()).length).toBe(baseCounts.creds);
        expect((yield* groupProv.list!()).length).toBe(baseCounts.groups);
        expect((yield* hookProv.list!()).length).toBe(baseCounts.hooks);
      }),
    { tags: ["provider:render", "live"], exclusive: true, timeout: 240_000 },
  );

  t.test.provider.skipIf(skipLive)(
    "reconciles WebService, PrivateService, BackgroundWorker, CronJob, StaticSite, and EnvGroupLink cleanly",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const projectProv = yield* Provider.findProvider(Render.Project);
        const groupProv = yield* Provider.findProvider(Render.EnvGroup);
        const webProv = yield* Provider.findProvider(Render.WebService);
        const privProv = yield* Provider.findProvider(Render.PrivateService);
        const workerProv = yield* Provider.findProvider(Render.BackgroundWorker);
        const cronProv = yield* Provider.findProvider(Render.CronJob);
        const siteProv = yield* Provider.findProvider(Render.StaticSite);

        const baseCounts = {
          projects: (yield* projectProv.list!()).length,
          groups: (yield* groupProv.list!()).length,
          webs: (yield* webProv.list!()).length,
          privs: (yield* privProv.list!()).length,
          workers: (yield* workerProv.list!()).length,
          crons: (yield* cronProv.list!()).length,
          sites: (yield* siteProv.list!()).length,
        };

        const program = (version: "v1" | "v2", options?: { readonly suspendWeb?: boolean }) =>
          Effect.gen(function* () {
            const proj = yield* Render.Project("LiveSvcProject", {
              environments: {
                staging: { name: "staging", protectedStatus: "unprotected" },
              },
            });
            const extraGroup = yield* Render.EnvGroup("LiveSvcEnvGroup", {
              environmentId: proj.environments.staging.id,
              envVars: {
                SHARED_TAG: version,
              },
            });

            const web = yield* Render.WebService("LiveWeb", {
              plan: "free",
              region: "oregon",
              environmentId: proj.environments.staging.id,
              envVars: { SERVICE_TAG: version },
              ...(options?.suspendWeb !== undefined ? { suspended: options.suspendWeb } : {}),
              skipDeployAfterUpdate: true,
              runtimeSource: {
                image: {
                  imagePath: "docker.io/nginxdemos/hello",
                  tag: "plain-text",
                },
              },
            });

            const priv = yield* Render.PrivateService("LivePriv", {
              plan: "starter",
              region: "oregon",
              environmentId: proj.environments.staging.id,
              skipDeployAfterUpdate: true,
              runtimeSource: {
                image: {
                  imagePath: "docker.io/nginxdemos/hello",
                  tag: "plain-text",
                },
              },
            });

            const worker = yield* Render.BackgroundWorker("LiveWorker", {
              plan: "starter",
              region: "oregon",
              environmentId: proj.environments.staging.id,
              skipDeployAfterUpdate: true,
              runtimeSource: {
                image: {
                  imagePath: "docker.io/nginxdemos/hello",
                  tag: "plain-text",
                },
              },
            });

            const cron = yield* Render.CronJob("LiveCron", {
              plan: "starter",
              region: "oregon",
              environmentId: proj.environments.staging.id,
              schedule: version === "v1" ? "0 0 * * *" : "30 2 * * *",
              skipDeployAfterUpdate: true,
              runtimeSource: {
                image: {
                  imagePath: "docker.io/nginxdemos/hello",
                  tag: "plain-text",
                },
              },
            });

            const site = yield* Render.StaticSite("LiveSite", {
              environmentId: proj.environments.staging.id,
              repo: "https://github.com/render-examples/create-react-app",
              branch: "master",
              buildCommand: "echo ok",
              publishPath: "public",
              autoDeploy: false,
              envVars: { SITE_TAG: version },
            });

            const link = yield* Render.EnvGroupLink("LiveSvcLink", {
              envGroupId: extraGroup.id,
              serviceIds: [web.id, priv.id],
            });

            return { proj, group: extraGroup, web, priv, worker, cron, site, link };
          });

        const deployed = yield* stack.deploy(program("v1"));
        expect(deployed.web.id).toBeDefined();
        expect(deployed.priv.id).toBeDefined();
        expect(deployed.worker.id).toBeDefined();
        expect(deployed.cron.schedule).toBe("0 0 * * *");
        expect(deployed.site.id).toBeDefined();
        expect(deployed.link.serviceIds.sort()).toEqual([deployed.web.id, deployed.priv.id].sort());

        // Verify idempotent plan with zero drift
        const noopPlan = yield* stack.plan(program("v1"));
        expect(
          Object.fromEntries(Object.entries(noopPlan.resources).map(([k, v]) => [k, v?.action])),
        ).toEqual({
          LiveSvcProject: "noop",
          LiveSvcEnvGroup: "noop",
          LiveWeb: "noop",
          LivePriv: "noop",
          LiveWorker: "noop",
          LiveCron: "noop",
          LiveSite: "noop",
          LiveSvcLink: "noop",
        });

        // Lookup checks
        expect((yield* webProv.lookup!({ id: deployed.web.id }))?.id).toBe(deployed.web.id);
        expect((yield* privProv.lookup!({ id: deployed.priv.id }))?.id).toBe(deployed.priv.id);
        expect((yield* workerProv.lookup!({ id: deployed.worker.id }))?.id).toBe(
          deployed.worker.id,
        );
        expect((yield* cronProv.lookup!({ id: deployed.cron.id }))?.id).toBe(deployed.cron.id);
        expect((yield* siteProv.lookup!({ id: deployed.site.id }))?.id).toBe(deployed.site.id);

        // Update pass (including suspend -> resume on the temporary WebService + read-only log query)
        const updated = yield* stack.deploy(program("v2"));
        expect(updated.web.id).toBe(deployed.web.id);
        expect(Redacted.value(updated.web.envVars.SERVICE_TAG)).toBe("v2");
        expect(updated.cron.schedule).toBe("30 2 * * *");

        const paused = yield* stack.deploy(program("v2", { suspendWeb: true }));
        expect(paused.web.suspended).toBe("suspended");

        const resumed = yield* stack.deploy(program("v2", { suspendWeb: false }));
        expect(resumed.web.suspended).toBe("not_suspended");

        const webLogs = yield* webProv.logs!({
          id: "LiveWeb",
          fqn: "LiveWeb",
          instanceId: resumed.web.id,
          props: {
            runtimeSource: {
              image: { imagePath: "docker.io/nginxdemos/hello", tag: "plain-text" },
            },
          },
          output: resumed.web,
          options: { since: new Date(Date.now() - 10 * 60 * 1000), limit: 20 },
        });
        expect(Array.isArray(webLogs)).toBe(true);

        yield* stack.destroy();
        expect((yield* projectProv.list!()).length).toBe(baseCounts.projects);
        expect((yield* groupProv.list!()).length).toBe(baseCounts.groups);
        expect((yield* webProv.list!()).length).toBe(baseCounts.webs);
        expect((yield* privProv.list!()).length).toBe(baseCounts.privs);
        expect((yield* workerProv.list!()).length).toBe(baseCounts.workers);
        expect((yield* cronProv.list!()).length).toBe(baseCounts.crons);
        expect((yield* siteProv.list!()).length).toBe(baseCounts.sites);
      }),
    { tags: ["provider:render", "live"], exclusive: true, timeout: 240_000 },
  );

  t.test.provider.skipIf(skipLive)(
    "provisions Postgres with real SQL migrations, KeyValue over TLS rediss://, ConnectPostgres & ReadWriteKeyValue bindings, and destroys cleanly",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const pgProv = yield* Provider.findProvider(Render.Postgres);
        const kvProv = yield* Provider.findProvider(Render.KeyValue);
        const webProv = yield* Provider.findProvider(Render.WebService);

        const baseCounts = {
          postgres: (yield* pgProv.list!()).length,
          keyValues: (yield* kvProv.list!()).length,
          webs: (yield* webProv.list!()).length,
        };

        const migDir = yield* Effect.promise(() =>
          fs.mkdtemp(path.join(os.tmpdir(), "alchemy-render-pg-mig-")),
        );
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(migDir, "0001_init.sql"),
            [
              "CREATE TABLE IF NOT EXISTS alchemy_render_live_check (",
              "  id SERIAL PRIMARY KEY,",
              "  label TEXT NOT NULL",
              ");",
              "INSERT INTO alchemy_render_live_check (label) VALUES ('ok');",
            ].join("\n"),
            "utf8",
          ),
        );

        const program = (version: "v1" | "v2") =>
          Effect.gen(function* () {
            const db = yield* Render.Postgres("LiveDb", {
              plan: "basic_256mb",
              region: "oregon",
              version: "16",
              diskSizeGB: 5,
              ipAllowList: [
                {
                  cidrBlock: "0.0.0.0/0",
                  description: version === "v1" ? "alchemy-live-test" : "alchemy-live-test-v2",
                },
              ],
              migrations: migDir,
            });

            const kv = yield* Render.KeyValue("LiveKv", {
              plan: "starter",
              region: "oregon",
              maxmemoryPolicy: version === "v1" ? "allkeys_lru" : "volatile_lru",
              ipAllowList: [{ cidrBlock: "0.0.0.0/0", description: "alchemy-live-test" }],
            });

            const web = yield* Render.WebService(
              "LiveBoundWeb",
              Effect.gen(function* () {
                yield* Render.ConnectPostgres(db);
                yield* Render.ReadWriteKeyValue(kv);
                return {
                  plan: "free",
                  region: "oregon",
                  skipDeployAfterUpdate: true,
                  runtimeSource: {
                    image: {
                      imagePath: "docker.io/nginxdemos/hello",
                      tag: "plain-text",
                    },
                  },
                };
              }),
            );

            return { db, kv, web };
          });

        const effectBody = Effect.gen(function* () {
          const deployed = yield* stack.deploy(program("v1"));
          expect(deployed.db.status).toBe("available");
          expect(deployed.db.origin.port).toBe(5432);
          expect(["none", "pgbouncer"]).toContain(deployed.db.connectionPool);
          expect(deployed.db.recovery?.recoveryStatus).toBeDefined();
          const exportsList = yield* Render.listPostgresExports(deployed.db.id);
          expect(Array.isArray(exportsList)).toBe(true);
          expect(deployed.kv.status).toBe("available");
          expect(Object.keys(deployed.db.migrationsHashes)).toContain("0001_init.sql");

          // Verify bound env vars landed on Render WebService
          expect(Redacted.value(deployed.web.envVars[Render.DATABASE_URL_ENV])).toBe(
            Redacted.value(deployed.db.connectionInfo.internalConnectionString),
          );
          expect(Redacted.value(deployed.web.envVars.REDIS_URL)).toBe(
            Redacted.value(deployed.kv.connectionInfo.internalConnectionString),
          );

          // Verify real Postgres SQL migration actually ran on the live database
          const rows = yield* Effect.promise(async () => {
            const client = new pg.Client({
              connectionString: stripSslQueryParams(
                Redacted.value(deployed.db.connectionInfo.externalConnectionString),
              ),
              ssl: { rejectUnauthorized: false },
            });
            await client.connect();
            try {
              const res = await client.query<{ label: string }>(
                "SELECT label FROM alchemy_render_live_check",
              );
              return res.rows;
            } finally {
              await client.end();
            }
          });
          expect(rows.map((r) => r.label)).toEqual(["ok"]);

          // Verify real ReadWriteKeyValue over TLS rediss:// external connection URL
          const externalRedisUrl = Redacted.value(
            deployed.kv.connectionInfo.externalConnectionString,
          );
          expect(externalRedisUrl.startsWith("redis")).toBe(true);
          const kvClient = yield* Render.ReadWriteKeyValue({
            Type: "Render.KeyValue",
            LogicalId: "LiveKv",
            connectionInfo: deployed.kv.connectionInfo,
          } as unknown as Render.KeyValue).pipe(Effect.provide(Render.ReadWriteKeyValueHttp));
          yield* withRuntimeFlag(
            Effect.gen(function* () {
              const rtLayer = makeMemoryRuntimeContext({
                REDIS_URL: externalRedisUrl,
              });
              const pong = yield* kvClient.ping().pipe(Effect.provide(rtLayer));
              expect(pong).toBe("PONG");
              yield* kvClient.set("alchemy:live:key", "render-ok").pipe(Effect.provide(rtLayer));
              const got = yield* kvClient.get("alchemy:live:key").pipe(Effect.provide(rtLayer));
              expect(got).toBe("render-ok");
            }).pipe(
              Effect.provide(
                ConfigProvider.layer(ConfigProvider.fromUnknown({ REDIS_URL: externalRedisUrl })),
              ),
            ),
          );

          // Verify idempotent noop plan
          const noopPlan = yield* stack.plan(program("v1"));
          expect(
            Object.fromEntries(Object.entries(noopPlan.resources).map(([k, v]) => [k, v?.action])),
          ).toEqual({
            LiveDb: "noop",
            LiveKv: "noop",
            LiveBoundWeb: "noop",
          });

          // Update Postgres ipAllowList description and KeyValue maxmemoryPolicy
          const updated = yield* stack.deploy(program("v2"));
          expect(updated.db.id).toBe(deployed.db.id);
          expect(updated.db.ipAllowList[0]?.description).toBe("alchemy-live-test-v2");
          expect(updated.kv.id).toBe(deployed.kv.id);
          expect(updated.kv.maxmemoryPolicy).toBe("volatile_lru");

          yield* stack.destroy();
          expect((yield* pgProv.list!()).length).toBe(baseCounts.postgres);
          expect((yield* kvProv.list!()).length).toBe(baseCounts.keyValues);
          expect((yield* webProv.list!()).length).toBe(baseCounts.webs);
        }).pipe(
          Effect.ensuring(Effect.promise(() => fs.rm(migDir, { recursive: true, force: true }))),
        );

        yield* effectBody;
      }),
    { tags: ["provider:render", "live"], exclusive: true, timeout: 240_000 },
  );
});
