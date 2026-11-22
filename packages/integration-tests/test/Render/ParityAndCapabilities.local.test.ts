import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as Render from "@alchemy.run/render";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { adopt, Unowned, Unresolved } from "alchemy/AdoptPolicy";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { ResourceContext } from "alchemy/ResourceContext";
import { type BaseRuntimeContext, RuntimeContext } from "alchemy/RuntimeContext";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as State from "alchemy/State";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { FakeRenderServer } from "./FakeRenderServer.ts";

const makeMockRuntimeContext = (
  type: string,
  env: Record<string, string | Redacted.Redacted<string>> = {},
) => {
  const stored = new Map<string, unknown>(Object.entries(env));
  const service: BaseRuntimeContext = {
    Type: type,
    id: "mock-host",
    env: Object.fromEntries(Object.entries(env)),
    get: <T>(key: string) => Effect.succeed(stored.get(key) as T | undefined),
    set: (id: string, value: unknown) =>
      Effect.sync(() => {
        stored.set(id, value);
        service.env[id] = value as string | Redacted.Redacted<string>;
        return id;
      }),
  };
  return {
    stored,
    layer: Layer.succeed(RuntimeContext, service),
  };
};

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

describe(
  "Render Parity & Alchemy-Native Capabilities",
  { tags: ["provider:render", "local"], timeout: 60_000 },
  () => {
    const fake = new FakeRenderServer({
      customDomainInitialVerificationStatus: "unverified",
      workflowVersionReadyAfterPolls: 2,
      postgresReadyAfterPolls: 1,
      deployReadyAfterPolls: 1,
    });
    const t = Test.make({
      providers: fake.providersLayer({ pollIntervalMs: 5, pollMaxAttempts: 20 }),
    });
    t.afterAll(Effect.sync(() => fake.stop()));

    t.test.provider(
      "validates HTTP responses with Effect Schema, handles 200 null arrays, and fails without retry on RenderSchemaError",
      () =>
        Effect.gen(function* () {
          const workflowProv = yield* Provider.findProvider(Render.Workflow);
          // Empty GET /workflows returns HTTP 200 null from FakeRenderServer (matching live Render)
          const emptyWorkflows = yield* workflowProv.list!();
          expect(emptyWorkflows).toEqual([]);

          fake.clearCalls();
          fake.pushFault({
            method: "GET",
            path: "/projects",
            status: 200,
            body: [{ cursor: "1", project: { id: 123, bogus: true } }],
            remaining: 1,
          });
          const projectProv = yield* Provider.findProvider(Render.Project);
          const schemaErr = yield* projectProv.list!().pipe(Effect.flip);
          expect(schemaErr).toBeInstanceOf(Render.RenderSchemaError);
          expect(fake.calls.filter((c) => c.path === "/projects").length).toBe(1);
        }),
      { tags: ["provider:render", "local"], timeout: 60_000 },
    );

    t.test.provider(
      "supports Postgres parity (connectionPool, origin, suspend/resume, recovery, restoreFrom, exports, importFiles diff)",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const primary = yield* Render.Postgres("PoolPg", {
                name: "pool-pg",
                plan: "basic_256mb",
                region: "oregon",
                connectionPool: "pgbouncer",
              });

              const consumer = yield* Render.WebService(
                "PoolConsumer",
                Effect.gen(function* () {
                  yield* Render.ConnectPostgres(primary);
                  return {
                    name: "pool-consumer",
                    plan: "starter",
                    region: "oregon",
                    runtimeSource: { image: { imagePath: "ghcr.io/alchemy/app", tag: "v1" } },
                  };
                }),
              );

              return { primary, consumer };
            }),
          );

          expect(deployed.primary.connectionPool).toBe("pgbouncer");
          expect(deployed.primary.origin.port).toBe(5432);
          expect(deployed.primary.origin.host).toBe(
            `${deployed.primary.id}-a.oregon-postgres.render.com`,
          );
          expect(deployed.primary.pooledOrigin?.port).toBe(6432);
          expect(
            Redacted.value(deployed.primary.connectionInfo.pooledInternalConnectionString!),
          ).toContain(":6432/");
          expect(
            Redacted.value(deployed.primary.connectionInfo.pooledExternalConnectionString!),
          ).toContain(":6432/");
          expect(deployed.primary.recovery?.recoveryStatus).toBe("available");

          const pgKeys = Render.connectPostgresEnvKeys({ LogicalId: "PoolPg" });
          expect(Redacted.value(deployed.consumer.envVars[pgKeys.pooledInternal])).toContain(
            ":6432/",
          );
          expect(Redacted.value(deployed.consumer.envVars[pgKeys.pooledExternal])).toContain(
            ":6432/",
          );

          // Exports
          const exported = yield* Render.createPostgresExport(deployed.primary.id);
          expect(exported.url).toContain(deployed.primary.id);
          const exportsList = yield* Render.listPostgresExports(deployed.primary.id);
          expect(exportsList.map((e) => e.id)).toContain(exported.id);

          // Suspend -> resume -> PITR restoreFrom
          const suspended = yield* stack.deploy(
            Effect.gen(function* () {
              const primary = yield* Render.Postgres("PoolPg", {
                name: "pool-pg",
                plan: "basic_256mb",
                region: "oregon",
                connectionPool: "pgbouncer",
                suspended: true,
              });
              const restored = yield* Render.Postgres("RestoredPg", {
                name: "restored-pg",
                plan: "basic_256mb",
                connectionPool: "pgbouncer",
                restoreFrom: {
                  sourcePostgresId: primary.id,
                  restoreTime: "2026-01-01T00:05:00.000Z",
                },
              });
              return { primary, restored };
            }),
          );
          expect(suspended.primary.suspended).toBe("suspended");
          expect(suspended.restored.id).not.toBe(suspended.primary.id);
          expect(suspended.restored.pooledOrigin?.port).toBe(6432);

          // Replacing restoreTime triggers Postgres replacement
          const replacedRestore = yield* stack.deploy(
            Effect.gen(function* () {
              const primary = yield* Render.Postgres("PoolPg", {
                name: "pool-pg",
                plan: "basic_256mb",
                region: "oregon",
                connectionPool: "pgbouncer",
                suspended: false,
              });
              const restored = yield* Render.Postgres("RestoredPg", {
                name: "restored-pg",
                plan: "basic_256mb",
                connectionPool: "pgbouncer",
                restoreFrom: {
                  sourcePostgresId: primary.id,
                  restoreTime: "2026-01-01T00:10:00.000Z",
                },
              });
              return { primary, restored };
            }),
          );
          expect(replacedRestore.primary.suspended).toBe("not_suspended");
          expect(replacedRestore.restored.id).not.toBe(suspended.restored.id);

          // importFiles content-hash change detection via PostgresProvider.diff
          const sqlDir = yield* Effect.promise(() =>
            fs.mkdtemp(path.join(os.tmpdir(), "alchemy-render-import-")),
          );
          const sqlFile = path.join(sqlDir, "seed.sql");
          try {
            yield* Effect.promise(() => fs.writeFile(sqlFile, "SELECT 1;\n", "utf8"));
            const pgProv = yield* Provider.findProvider(Render.Postgres);
            const firstDiff = yield* pgProv.diff!({
              id: "ImportCheck",
              fqn: "test/ImportCheck",
              instanceId: "inst-1",
              olds: { importFiles: [sqlFile] },
              news: { importFiles: [sqlFile] },
              oldBindings: [],
              newBindings: [],
              output: {
                ...replacedRestore.primary,
                importHashes: {},
              },
            });
            expect(firstDiff).toEqual({ action: "update" });
          } finally {
            yield* Effect.promise(() => fs.rm(sqlDir, { recursive: true, force: true }));
          }

          yield* stack.destroy();
          expect(fake.snapshotCounts().postgres).toBe(0);
        }),
      { tags: ["provider:render", "local"], timeout: 60_000 },
    );

    t.test.provider(
      "reconciles compute parity, Workflow, Blueprint, and ServicePreview lifecycles",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const bpId = fake.seedBlueprint({
            name: "existing-bp",
            resources: [{ id: "srv-seeded", name: "seeded-web", type: "web_service" }],
          });

          const validRes = yield* Render.validateBlueprint({
            yaml: "services:\n  - type: web\n    name: app\n",
          });
          expect(validRes.valid).toBe(true);

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const proj = yield* Render.Project("ParityProj", {
                name: "parity-proj",
                environments: {
                  staging: { name: "staging", protectedStatus: "unprotected" },
                },
              });

              const web = yield* Render.WebService("ParityWeb", {
                name: "parity-web",
                plan: "starter",
                buildPlan: "performance",
                region: "oregon",
                cacheProfile: "origin-controlled",
                customDomains: ["parity.example.test"],
                verifyCustomDomains: true,
                suspended: true,
                runtimeSource: {
                  image: {
                    imagePath: "ghcr.io/alchemy/parity-web",
                    tag: "v1",
                    autoDeploy: false,
                    autoDeployTrigger: "checksPass",
                  },
                },
              });

              const preview = yield* Render.ServicePreview("PrPreview", {
                baseServiceId: web.id,
                name: "parity-web-pr-1",
                imagePath: "ghcr.io/alchemy/parity-web:pr-1",
                plan: "starter",
              });

              const wf = yield* Render.Workflow("NightlyFlow", {
                name: "nightly-flow",
                region: "oregon",
                environmentId: proj.environments.staging.id,
                runtime: "node",
                repo: "https://github.com/alchemy/workflows",
                branch: "main",
                buildCommand: "pnpm build",
                runCommand: "node dist/workflows.js",
                deployVersion: true,
                waitForVersionCompletion: true,
                envVars: { WF_MODE: "v1" },
              });

              const bp = yield* Render.Blueprint("InfraBp", {
                blueprintId: bpId,
                autoSync: false,
                branch: "release",
                path: "infra/render.yaml",
                validateYaml: "services:\n  - type: web\n    name: app\n",
                disconnectOnDelete: false,
              }).pipe(adopt(true));

              return { proj, web, preview, wf, bp };
            }),
          );

          expect(deployed.web.buildPlan).toBe("performance");
          expect(deployed.web.cacheProfile).toBe("origin-controlled");
          expect(deployed.web.suspended).toBe("suspended");
          expect(deployed.web.customDomains[0]?.verificationStatus).toBe("verified");
          expect(deployed.web.autoDeployTrigger).toBe("checksPass");

          expect(deployed.preview.baseServiceId).toBe(deployed.web.id);
          expect(deployed.preview.imagePath).toBe("ghcr.io/alchemy/parity-web:pr-1");

          expect(deployed.wf.defaultVersionId).toBeDefined();
          expect(deployed.wf.environmentId).toBe(deployed.proj.environments.staging.id);
          expect(Redacted.value(deployed.wf.envVars.WF_MODE)).toBe("v1");

          expect(deployed.bp.autoSync).toBe(false);
          expect(deployed.bp.branch).toBe("release");
          expect(deployed.bp.path).toBe("infra/render.yaml");
          expect(deployed.bp.resources.length).toBe(1);
          expect(deployed.bp.recentSyncs.length).toBe(1);

          // Manual cache purge + resume + invalid blueprint rejection
          yield* Render.purgeServiceCache(deployed.web.id);
          expect(
            fake.calls.some(
              (c) => c.method === "POST" && c.path === `/services/${deployed.web.id}/cache/purge`,
            ),
          ).toBe(true);

          const badYamlErr = yield* Render.validateBlueprint({
            yaml: "INVALID_BLUEPRINT",
          }).pipe(Effect.map((r) => r.valid));
          expect(badYamlErr).toBe(false);

          // Resume web service and replace Workflow by region
          const updated = yield* stack.deploy(
            Effect.gen(function* () {
              const proj = yield* Render.Project("ParityProj", {
                name: "parity-proj",
                environments: {
                  staging: { name: "staging", protectedStatus: "unprotected" },
                },
              });
              const web = yield* Render.WebService("ParityWeb", {
                name: "parity-web",
                plan: "starter",
                buildPlan: "performance",
                region: "oregon",
                cacheProfile: "no-cache",
                suspended: false,
                runtimeSource: {
                  image: {
                    imagePath: "ghcr.io/alchemy/parity-web",
                    tag: "v1",
                  },
                },
              });
              const preview = yield* Render.ServicePreview("PrPreview", {
                baseServiceId: web.id,
                name: "parity-web-pr-1",
                imagePath: "ghcr.io/alchemy/parity-web:pr-2",
                plan: "standard",
              });
              const wf = yield* Render.Workflow("NightlyFlow", {
                name: "nightly-flow",
                region: "ohio",
                runtime: "node",
                repo: "https://github.com/alchemy/workflows",
                branch: "main",
                buildCommand: "pnpm build",
                runCommand: "node dist/workflows-v2.js",
              });
              const bp = yield* Render.Blueprint("InfraBp", {
                blueprintId: bpId,
                autoSync: true,
                disconnectOnDelete: true,
              });
              return { proj, web, preview, wf, bp };
            }),
          );

          expect(updated.web.suspended).toBe("not_suspended");
          expect(updated.web.cacheProfile).toBe("no-cache");
          expect(updated.preview.id).toBe(deployed.preview.id);
          expect(updated.preview.imagePath).toBe("ghcr.io/alchemy/parity-web:pr-2");
          expect(updated.preview.plan).toBe("standard");
          expect(updated.wf.id).not.toBe(deployed.wf.id);
          expect(updated.wf.region).toBe("ohio");
          expect(updated.bp.autoSync).toBe(true);

          yield* stack.destroy();
          expect(fake.snapshotCounts().services).toBe(0);
          expect(fake.parityCounts().workflows).toBe(0);
          expect(fake.parityCounts().blueprints).toBe(0);
        }),
      { tags: ["provider:render", "local"], timeout: 60_000 },
    );

    t.test.provider(
      "hardens crash-recovery read & Unowned conflict protection across Render resources",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          // Deploy auto-named stack, verify read() without output recovers auto-named Project as owned
          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const proj = yield* Render.Project("AutoProj", {});
              const env = yield* Render.Environment("AutoEnv", { projectId: proj.id });
              const group = yield* Render.EnvGroup("AutoGroup", {
                envVars: { FOO: "bar" },
              });
              const hook = yield* Render.Webhook("AutoHook", {
                url: "https://example.com/hook",
                eventFilter: ["deploy_ended"],
              });
              const cred = yield* Render.RegistryCredential("AutoCred", {
                registry: "DOCKER",
                username: "bot",
                authToken: Redacted.make("secret-token"),
              });
              const wf = yield* Render.Workflow("AutoWf", {
                runtime: "node",
                repo: "https://github.com/alchemy/wf",
                buildCommand: "pnpm build",
                runCommand: "node dist/wf.js",
              });
              return { proj, env, group, hook, cred, wf };
            }),
          );

          const stackMeta = yield* Stack;
          const stage = yield* Stage;
          const state = yield* Effect.flatten(State.State);
          const autoProjState = yield* state.get({
            stack: stackMeta.name,
            stage,
            fqn: "AutoProj",
          });
          const autoInstanceId = State.isResourceState(autoProjState)
            ? autoProjState.instanceId
            : "";
          expect(autoInstanceId.length).toBeGreaterThan(0);

          const projProv = yield* Provider.findProvider(Render.Project);
          const recoveredAutoProj = yield* projProv.read!({
            id: "AutoProj",
            fqn: "AutoProj",
            instanceId: autoInstanceId,
            olds: {},
            output: undefined,
          }).pipe(
            Effect.provideService(ResourceContext, {
              logicalId: "AutoProj",
              fqn: "AutoProj",
              instanceId: autoInstanceId,
              type: "Render.Project",
            }),
          );
          expect(recoveredAutoProj?.id).toBe(deployed.proj.id);
          expect(Unowned.is(recoveredAutoProj)).toBe(false);

          // Explicit name without matching previous.id returns Unowned
          const unownedProjRead = yield* projProv.read!({
            id: "OtherProj",
            fqn: "OtherProj",
            instanceId: "inst-2",
            olds: { name: deployed.proj.name },
            output: undefined,
          }).pipe(
            Effect.provideService(ResourceContext, {
              logicalId: "OtherProj",
              fqn: "OtherProj",
              instanceId: "inst-2",
              type: "Render.Project",
            }),
          );
          expect(unownedProjRead?.id).toBe(deployed.proj.id);
          expect(Unowned.is(unownedProjRead)).toBe(true);

          const hookProv = yield* Provider.findProvider(Render.Webhook);
          const unownedHookRead = yield* hookProv.read!({
            id: "OtherHook",
            fqn: "OtherHook",
            instanceId: "inst-2",
            olds: { name: deployed.hook.name, url: "https://example.com/hook" },
            output: undefined,
          }).pipe(
            Effect.provideService(ResourceContext, {
              logicalId: "OtherHook",
              fqn: "OtherHook",
              instanceId: "inst-2",
              type: "Render.Webhook",
            }),
          );
          expect(unownedHookRead?.id).toBe(deployed.hook.id);
          expect(Unowned.is(unownedHookRead)).toBe(true);

          const wfProv = yield* Provider.findProvider(Render.Workflow);
          const unownedWfRead = yield* wfProv.read!({
            id: "OtherWf",
            fqn: "OtherWf",
            instanceId: "inst-2",
            olds: {
              name: deployed.wf.name,
              runtime: "node",
              repo: "https://github.com/alchemy/wf",
              buildCommand: "pnpm build",
              runCommand: "node dist/wf.js",
            },
            output: undefined,
          }).pipe(
            Effect.provideService(ResourceContext, {
              logicalId: "OtherWf",
              fqn: "OtherWf",
              instanceId: "inst-2",
              type: "Render.Workflow",
            }),
          );
          expect(unownedWfRead?.id).toBe(deployed.wf.id);
          expect(Unowned.is(unownedWfRead)).toBe(true);

          // Blueprint seeded outside state fails with OwnedBySomeoneElse unless adopt(true)
          fake.seedBlueprint({ name: "foreign-bp-conflict" });
          const conflictErr = yield* stack
            .deploy(
              Effect.gen(function* () {
                const bp = yield* Render.Blueprint("ConflictBp", {
                  name: "foreign-bp-conflict",
                }).pipe(adopt(false));
                return { bp };
              }),
            )
            .pipe(Effect.flip);
          expect(conflictErr).toMatchObject({ _tag: "OwnedBySomeoneElse" });

          const adopted = yield* stack.deploy(
            Effect.gen(function* () {
              const proj = yield* Render.Project("AutoProj", {});
              const env = yield* Render.Environment("AutoEnv", { projectId: proj.id });
              const group = yield* Render.EnvGroup("AutoGroup", { envVars: { FOO: "bar" } });
              const hook = yield* Render.Webhook("AutoHook", {
                url: "https://example.com/hook",
                eventFilter: ["deploy_ended"],
              });
              const cred = yield* Render.RegistryCredential("AutoCred", {
                registry: "DOCKER",
                username: "bot",
                authToken: Redacted.make("secret-token"),
              });
              const wf = yield* Render.Workflow("AutoWf", {
                runtime: "node",
                repo: "https://github.com/alchemy/wf",
                buildCommand: "pnpm build",
                runCommand: "node dist/wf.js",
              });
              const bp = yield* Render.Blueprint("ConflictBp", {
                name: "foreign-bp-conflict",
                disconnectOnDelete: true,
              }).pipe(adopt(true));
              return { proj, env, group, hook, cred, wf, bp };
            }),
          );
          expect(adopted.bp.name).toBe("foreign-bp-conflict");

          yield* stack.destroy();
          expect(fake.snapshotCounts().projects).toBe(0);
          expect(fake.parityCounts().workflows).toBe(0);
          expect(fake.parityCounts().blueprints).toBe(0);
        }),
      { tags: ["provider:render", "local"], timeout: 60_000 },
    );

    t.test.provider(
      "provides Alchemy-native logs/tail, observe/precreate cycle breaking, ConnectService, and RunWorkflowTask",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          // Local HTTP echo server to exercise ConnectService.fetch end-to-end
          const echoServer = Bun.serve({
            port: 0,
            fetch(req) {
              const u = new URL(req.url);
              return Response.json({ ok: true, path: u.pathname });
            },
          });

          try {
            const deployed = yield* stack.deploy(
              Effect.gen(function* () {
                // Mutual binding cycle between WebService (CycleA) and PrivateService (CycleB):
                // CycleA precreates, CycleB binds ConnectService(CycleA), CycleA receives CycleB's URL/slug.
                const cycleA = yield* Render.WebService("CycleA", {
                  name: "cycle-a",
                  plan: "starter",
                  region: "oregon",
                  runtimeSource: { image: { imagePath: "ghcr.io/alchemy/a", tag: "v1" } },
                });

                const cycleB = yield* Render.PrivateService(
                  "CycleB",
                  Effect.gen(function* () {
                    yield* Render.ConnectService(cycleA);
                    return {
                      name: "cycle-b",
                      plan: "starter",
                      region: "oregon",
                      runtimeSource: { image: { imagePath: "ghcr.io/alchemy/b", tag: "v1" } },
                    };
                  }),
                );

                yield* cycleA.bind`FromCycleB`({
                  env: {
                    CYCLE_B_URL: Output.map(cycleB.url, (u) => u ?? ""),
                    CYCLE_B_SLUG: cycleB.slug,
                  },
                });

                const db = yield* Render.Postgres("CapabilityDb", {
                  name: "capability-db",
                  plan: "basic_256mb",
                  region: "oregon",
                });

                const wf = yield* Render.Workflow("JobsWf", {
                  name: "jobs-wf",
                  region: "oregon",
                  runtime: "node",
                  repo: "https://github.com/alchemy/jobs",
                  buildCommand: "pnpm build",
                  runCommand: "node dist/jobs.js",
                });

                const caller = yield* Render.WebService(
                  "CallerWeb",
                  Effect.gen(function* () {
                    yield* Render.ConnectService(cycleB);
                    yield* Render.RunWorkflowTask(wf);
                    return {
                      name: "caller-web",
                      plan: "starter",
                      region: "oregon",
                      runtimeSource: { image: { imagePath: "ghcr.io/alchemy/caller", tag: "v1" } },
                    };
                  }),
                );

                return { cycleA, cycleB, db, wf, caller };
              }),
            );

            // Cycle precreate + converge assertions
            expect(Redacted.value(deployed.cycleA.envVars.CYCLE_B_SLUG)).toBe(deployed.cycleB.slug);
            const cycleAKeys = Render.connectServiceEnvKeys({ LogicalId: "CycleA" });
            const cycleBKeys = Render.connectServiceEnvKeys({ LogicalId: "CycleB" });
            const wfKeys = Render.runWorkflowTaskEnvKeys({ LogicalId: "JobsWf" });
            expect(deployed.cycleB.envVars[cycleAKeys.url]).toBeDefined();
            expect(Redacted.value(deployed.cycleB.envVars[cycleAKeys.url])).toBe(
              `https://cycle-a.onrender.com`,
            );
            // PrivateService url (`internal-host:10000`) normalized with `http://`
            expect(Redacted.value(deployed.caller.envVars[cycleBKeys.url])).toBe(
              "http://cycle-b:10000",
            );
            expect(Redacted.value(deployed.caller.envVars[wfKeys.slug])).toBe(deployed.wf.slug);

            // Provider.observe checks (Unresolved, absent, owned, Unowned)
            const webProv = yield* Provider.findProvider(Render.WebService);
            const unresolvedObs = yield* webProv.observe!({
              id: "CycleA",
              fqn: "test/CycleA",
              instanceId: "inst-1",
              news: {
                name: Output.fromEffect(Effect.succeed("dynamic")) as unknown as string,
                runtimeSource: { image: { imagePath: "ghcr.io/alchemy/a", tag: "v1" } },
              },
            });
            expect(unresolvedObs).toBe(Unresolved);

            const ownedObs = yield* webProv.observe!({
              id: "CycleA",
              fqn: "test/CycleA",
              instanceId: "inst-1",
              news: {
                name: "cycle-a",
                runtimeSource: { image: { imagePath: "ghcr.io/alchemy/a", tag: "v1" } },
              },
              previous: deployed.cycleA,
            });
            expect(ownedObs).toMatchObject({ id: deployed.cycleA.id, name: "cycle-a" });
            expect(Unowned.is(ownedObs)).toBe(false);

            const foreignObs = yield* webProv.observe!({
              id: "ForeignCheck",
              fqn: "test/ForeignCheck",
              instanceId: "inst-2",
              news: {
                name: "cycle-a",
                runtimeSource: { image: { imagePath: "ghcr.io/alchemy/a", tag: "v1" } },
              },
            });
            expect(Unowned.is(foreignObs)).toBe(true);

            // Provider.logs & Provider.tail across WebService, Postgres, and Workflow
            fake.appendLog({ resourceId: deployed.cycleA.id, message: "web boot 1" });
            fake.appendLog({ resourceId: deployed.cycleA.id, message: "web boot 2" });
            fake.appendLog({ resourceId: deployed.db.id, message: "pg checkpoint" });
            fake.appendLog({ resourceId: deployed.wf.id, message: "wf worker ready" });

            const webLogs = yield* webProv.logs!({
              id: "CycleA",
              fqn: "test/CycleA",
              instanceId: "inst-1",
              props: {
                name: "cycle-a",
                runtimeSource: { image: { imagePath: "ghcr.io/alchemy/a", tag: "v1" } },
              },
              output: deployed.cycleA,
              options: { since: new Date(Date.now() - 60_000), limit: 10 },
            });
            expect(webLogs.map((l) => l.message)).toEqual(["web boot 1", "web boot 2"]);
            expect(webLogs[0]?.timestamp).toBeInstanceOf(Date);

            const pgProv = yield* Provider.findProvider(Render.Postgres);
            const pgLogs = yield* pgProv.logs!({
              id: "CapabilityDb",
              fqn: "test/CapabilityDb",
              instanceId: "inst-1",
              props: {},
              output: deployed.db,
              options: {},
            });
            expect(pgLogs.map((l) => l.message)).toEqual(["pg checkpoint"]);

            const wfProv = yield* Provider.findProvider(Render.Workflow);
            const wfLogs = yield* wfProv.logs!({
              id: "JobsWf",
              fqn: "test/JobsWf",
              instanceId: "inst-1",
              props: {
                runtime: "node",
                repo: "https://github.com/alchemy/jobs",
                buildCommand: "pnpm build",
                runCommand: "node dist/jobs.js",
              },
              output: deployed.wf,
              options: {},
            });
            expect(wfLogs.map((l) => l.message)).toEqual(["wf worker ready"]);

            const tailFiber = yield* webProv.tail!({
              id: "CycleA",
              fqn: "test/CycleA",
              instanceId: "inst-1",
              props: {
                name: "cycle-a",
                runtimeSource: { image: { imagePath: "ghcr.io/alchemy/a", tag: "v1" } },
              },
              output: deployed.cycleA,
            }).pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);

            yield* Effect.sleep("40 millis");
            fake.appendLog({ resourceId: deployed.cycleA.id, message: "web stream 3" });
            const streamed = yield* Fiber.join(tailFiber);
            expect(streamed.map((l) => l.message)).toEqual([
              "web boot 1",
              "web boot 2",
              "web stream 3",
            ]);

            // ConnectService foreign host + live HTTP fetch + RunWorkflowTask runtime calls
            const mockSvc = {
              Type: "Render.WebService",
              LogicalId: "EchoTarget",
              url: echoServer.url.origin,
              slug: "echo-target",
            } as unknown as Render.WebService;
            const foreignRt = makeMockRuntimeContext("Foreign.Compute");
            const svcClient = yield* Render.ConnectService(mockSvc).pipe(
              Effect.provide(Render.ConnectServiceHttp),
              Effect.provide(foreignRt.layer),
            );
            const svcKeys = Render.connectServiceEnvKeys(mockSvc);
            expect(foreignRt.stored.has(svcKeys.url)).toBe(true);

            const mockWf = {
              Type: "Render.Workflow",
              LogicalId: "JobsWf",
              id: deployed.wf.id,
              slug: deployed.wf.slug,
            } as unknown as Render.Workflow;
            const wfClient = yield* Render.RunWorkflowTask(mockWf).pipe(
              Effect.provide(Render.RunWorkflowTaskHttp),
              Effect.provide(foreignRt.layer),
            );
            expect(foreignRt.stored.has(wfKeys.slug)).toBe(true);

            const runtimeRt = makeMockRuntimeContext("Foreign.Compute", {
              [svcKeys.url]: echoServer.url.origin,
              [svcKeys.slug]: "echo-target",
              [wfKeys.slug]: deployed.wf.slug,
            });
            const emptyRt = makeMockRuntimeContext("Foreign.Compute");

            yield* withRuntimeFlag(
              Effect.gen(function* () {
                const resp = yield* svcClient
                  .fetch(HttpClientRequest.get("/health"))
                  .pipe(Effect.provide(runtimeRt.layer), Effect.provide(FetchHttpClient.layer));
                const bodyJson = (yield* resp.json) as { ok: boolean; path: string };
                expect(bodyJson).toEqual({ ok: true, path: "/health" });

                const missingSvcErr = yield* svcClient.url.pipe(
                  Effect.provide(emptyRt.layer),
                  Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
                  Effect.flip,
                );
                expect(missingSvcErr).toBeInstanceOf(Render.ServiceUrlMissing);

                const triggered = yield* wfClient
                  .trigger("send-digest", { userId: "usr-1" })
                  .pipe(Effect.provide(runtimeRt.layer));
                expect(triggered.task).toBe(`${deployed.wf.slug}/send-digest`);

                const fetched = yield* wfClient.getRun(triggered.id);
                expect(fetched.id).toBe(triggered.id);

                const completed = yield* wfClient
                  .runAndWait("send-digest", { count: 2 })
                  .pipe(Effect.provide(runtimeRt.layer));
                expect(completed.status).toBe("completed");
                expect(completed.results).toEqual({ echo: { count: 2 } });

                yield* wfClient.cancelRun(completed.id);
                const canceled = yield* wfClient.getRun(completed.id);
                expect(canceled.status).toBe("canceled");

                const missingWfErr = yield* wfClient.workflowSlug.pipe(
                  Effect.provide(emptyRt.layer),
                  Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
                  Effect.flip,
                );
                expect(missingWfErr).toBeInstanceOf(Render.WorkflowSlugMissing);
              }),
            );

            yield* stack.destroy();
            expect(fake.snapshotCounts().services).toBe(0);
            expect(fake.snapshotCounts().postgres).toBe(0);
            expect(fake.parityCounts().workflows).toBe(0);
          } finally {
            echoServer.stop(true);
          }
        }),
      { tags: ["provider:render", "local"], timeout: 60_000 },
    );
  },
);
