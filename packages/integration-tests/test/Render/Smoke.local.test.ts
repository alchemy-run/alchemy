import * as Render from "@alchemy.run/render";
import { afterAll, describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { FakeRenderServer } from "./FakeRenderServer.ts";

describe(
  "Render Full Provider Smoke Stack",
  { tags: ["provider:render", "local"], timeout: 60_000 },
  () => {
    const fake = new FakeRenderServer({
      postgresReadyAfterPolls: 2,
      dedicatedIpReadyAfterPolls: 2,
      deployReadyAfterPolls: 2,
    });
    const t = Test.make({
      providers: fake.providersLayer({ pollIntervalMs: 1, pollMaxAttempts: 15 }),
    });
    afterAll(() => {
      fake.stop();
    });

    t.test.provider(
      "deploys all 18 Render resources end-to-end, re-deploys idempotently, updates, and destroys to zero remnants",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const program = (version: "v1" | "v2") =>
            Effect.gen(function* () {
              const project = yield* Render.Project("SmokeProject", {
                name: "smoke-project",
                environments: {
                  prod: { name: "prod", protectedStatus: "protected" },
                },
              });

              const extraEnv = yield* Render.Environment("SmokePreviewEnv", {
                projectId: project.id,
                name: version === "v1" ? "preview" : "preview-v2",
              });

              const regCred = yield* Render.RegistryCredential("SmokeReg", {
                name: "smoke-reg",
                registry: "GITHUB",
                username: "alchemy-smoke",
                authToken: Redacted.make(`tok_${version}`),
              });

              const db = yield* Render.Postgres("SmokeDb", {
                name: "smoke-db",
                plan: "basic_256mb",
                region: "oregon",
                environmentId: project.environments.prod.id,
              });

              const kv = yield* Render.KeyValue("SmokeKv", {
                name: "smoke-kv",
                plan: "starter",
                region: "oregon",
                environmentId: project.environments.prod.id,
              });

              const legacyRedis = yield* Render.Redis("SmokeRedis", {
                name: "smoke-redis",
                plan: "starter",
                region: "oregon",
                environmentId: extraEnv.id,
              });

              const envGroup = yield* Render.EnvGroup("SmokeEnvGroup", {
                name: "smoke-env-group",
                environmentId: project.environments.prod.id,
                envVars: {
                  APP_VERSION: version,
                  GENERATED_SECRET: { generateValue: true },
                },
              });

              const web = yield* Render.WebService(
                "SmokeWeb",
                Effect.gen(function* () {
                  yield* Render.ConnectPostgres(db);
                  yield* Render.ReadWriteKeyValue(kv);
                  return {
                    name: "smoke-web",
                    plan: "starter",
                    region: "oregon",
                    environmentId: project.environments.prod.id,
                    runtimeSource: {
                      image: {
                        imagePath: "ghcr.io/alchemy/smoke-web",
                        tag: version,
                        registryCredentialId: regCred.id,
                      },
                    },
                  };
                }),
              );

              const priv = yield* Render.PrivateService("SmokePriv", {
                name: "smoke-priv",
                plan: "starter",
                region: "oregon",
                environmentId: project.environments.prod.id,
                runtimeSource: {
                  image: { imagePath: "ghcr.io/alchemy/smoke-priv", tag: version },
                },
              });

              const worker = yield* Render.BackgroundWorker("SmokeWorker", {
                name: "smoke-worker",
                plan: "starter",
                region: "oregon",
                environmentId: project.environments.prod.id,
                runtimeSource: {
                  image: { imagePath: "ghcr.io/alchemy/smoke-worker", tag: version },
                },
              });

              const cron = yield* Render.CronJob("SmokeCron", {
                name: "smoke-cron",
                plan: "starter",
                region: "oregon",
                environmentId: project.environments.prod.id,
                schedule: version === "v1" ? "0 * * * *" : "*/30 * * * *",
                runtimeSource: {
                  image: { imagePath: "ghcr.io/alchemy/smoke-cron", tag: version },
                },
              });

              const site = yield* Render.StaticSite("SmokeSite", {
                name: "smoke-site",
                environmentId: project.environments.prod.id,
                repo: "https://github.com/alchemy/smoke-site",
                branch: "main",
                buildCommand: "pnpm build",
                publishPath: "dist",
              });

              const link = yield* Render.EnvGroupLink("SmokeLink", {
                envGroupId: envGroup.id,
                serviceIds: [web.id, priv.id],
              });

              const hook = yield* Render.Webhook("SmokeHook", {
                name: "smoke-hook",
                url: `https://hooks.example.test/${version}`,
                enabled: true,
              });

              const egress = yield* Render.DedicatedIp("SmokeEgress", {
                name: "smoke-egress",
                region: "oregon",
                environmentIds: [project.environments.prod.id],
              });

              const logs = yield* Render.LogStream("SmokeLogs", {
                endpoint: `logs-${version}.example.test:6514`,
                preview: "send",
              });

              const metrics = yield* Render.MetricsStream("SmokeMetrics", {
                provider: "GRAFANA",
                url: `https://metrics-${version}.example.test/otlp`,
                token: Redacted.make(`otel_${version}`),
              });

              const notify = yield* Render.NotificationSetting("SmokeNotify", {
                emailEnabled: true,
                notificationsToSend: version === "v1" ? "failure" : "all",
              });

              return {
                project,
                extraEnv,
                regCred,
                db,
                kv,
                legacyRedis,
                envGroup,
                web,
                priv,
                worker,
                cron,
                site,
                link,
                hook,
                egress,
                logs,
                metrics,
                notify,
              };
            });

          const first = yield* stack.deploy(program("v1"));
          expect(first.web.id).toBeDefined();
          expect(first.egress.status).toBe("RUNNING");
          expect(first.link.serviceIds.length).toBe(2);

          // Second identical deploy should be a noop plan
          const plan = yield* stack.plan(program("v1"));
          expect(
            Object.fromEntries(Object.entries(plan.resources).map(([k, v]) => [k, v?.action])),
          ).toEqual({
            SmokeProject: "noop",
            SmokePreviewEnv: "noop",
            SmokeReg: "noop",
            SmokeDb: "noop",
            SmokeKv: "noop",
            SmokeRedis: "noop",
            SmokeEnvGroup: "noop",
            SmokeWeb: "noop",
            SmokePriv: "noop",
            SmokeWorker: "noop",
            SmokeCron: "noop",
            SmokeSite: "noop",
            SmokeLink: "noop",
            SmokeHook: "noop",
            SmokeEgress: "noop",
            SmokeLogs: "noop",
            SmokeMetrics: "noop",
            SmokeNotify: "noop",
          });

          // Update pass across the stack
          const second = yield* stack.deploy(program("v2"));
          expect(second.web.id).toBe(first.web.id);
          expect(second.cron.schedule).toBe("*/30 * * * *");
          expect(second.notify.notificationsToSend).toBe("all");

          yield* stack.destroy();
          expect(fake.snapshotCounts()).toEqual({
            projects: 0,
            environments: 0,
            registryCredentials: 0,
            envGroups: 0,
            services: 0,
            disks: 0,
            postgres: 0,
            keyValues: 0,
            redis: 0,
            webhooks: 0,
            dedicatedIps: 0,
            ownerLogStreams: 0,
            resourceLogStreams: 0,
            metricsStreams: 0,
          });
        }),
      { tags: ["provider:render", "local"], timeout: 60_000 },
    );
  },
);
