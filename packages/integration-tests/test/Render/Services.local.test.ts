import * as Render from "@alchemy.run/render";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { FakeRenderServer } from "./FakeRenderServer.ts";

describe(
  "Render Compute Services (WebService, PrivateService, BackgroundWorker, CronJob, StaticSite)",
  { tags: ["provider:render", "local"], timeout: 60_000 },
  () => {
    const fake = new FakeRenderServer({ deployReadyAfterPolls: 2 });
    const providers = fake.providersLayer();
    const t = Test.make({ providers });
    t.afterAll(Effect.sync(() => fake.stop()));

    t.test.provider(
      "reconciles WebService (disk, scaling, custom domains, overrides, deploy poll), PrivateService, BackgroundWorker, CronJob, and StaticSite",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const proj = yield* Render.Project("SvcProject", {
                name: "svc-project",
                environments: {
                  staging: { name: "staging", protectedStatus: "unprotected" },
                  prod: { name: "prod", protectedStatus: "protected" },
                },
              });

              const web = yield* Render.WebService("WebApi", {
                name: "web-api",
                plan: "starter",
                region: "oregon",
                environmentId: proj.environments.staging.id,
                healthCheckPath: "/health",
                numInstances: 1,
                disk: { name: "uploads", mountPath: "/var/data", sizeGB: 5 },
                customDomains: ["api.example.test"],
                envVars: { NODE_ENV: "staging" },
                secretFiles: { "tls.crt": "CERT_V1" },
                notificationOverride: {
                  notificationsToSend: "failure",
                  previewNotificationsEnabled: "false",
                },
                logStreamOverride: {
                  setting: "send",
                  endpoint: "logs.example.test:6514",
                },
                runtimeSource: {
                  nativeRuntime: {
                    runtime: "node",
                    repo: "https://github.com/alchemy/web-api",
                    branch: "main",
                    buildCommand: "pnpm build",
                    autoDeployTrigger: "commit",
                  },
                },
                startCommand: "pnpm start",
                waitForDeployCompletion: true,
              });

              const priv = yield* Render.PrivateService("InternalGrpc", {
                name: "internal-grpc",
                plan: "starter",
                region: "oregon",
                runtimeSource: {
                  docker: {
                    repo: "https://github.com/alchemy/grpc",
                    branch: "main",
                    context: ".",
                    dockerfilePath: "./Dockerfile",
                  },
                },
                startCommand: "./server",
              });

              const worker = yield* Render.BackgroundWorker("QueueWorker", {
                name: "queue-worker",
                plan: "starter",
                region: "oregon",
                runtimeSource: {
                  image: { imagePath: "ghcr.io/alchemy/worker", tag: "v1" },
                },
              });

              const cron = yield* Render.CronJob("NightlyJob", {
                name: "nightly-job",
                plan: "starter",
                region: "oregon",
                schedule: "0 2 * * *",
                runtimeSource: {
                  image: { imagePath: "ghcr.io/alchemy/cron", digest: "sha256:abc123" },
                },
              });

              const site = yield* Render.StaticSite("MarketingSite", {
                name: "marketing-site",
                repo: "https://github.com/alchemy/marketing",
                branch: "main",
                buildCommand: "pnpm build",
                publishPath: "dist",
                headers: [{ path: "/assets/*", name: "Cache-Control", value: "max-age=3600" }],
                routes: [{ source: "/*", destination: "/index.html", type: "rewrite" }],
                customDomains: ["www.example.test"],
              });

              return { proj, web, priv, worker, cron, site };
            }),
          );

          expect(deployed.web.url).toBe("https://web-api.onrender.com");
          expect(deployed.web.disk?.sizeGB).toBe(5);
          expect(deployed.web.customDomains.map((d) => d.name)).toEqual(["api.example.test"]);
          expect(deployed.web.notificationOverride?.notificationsToSend).toBe("failure");
          expect(deployed.web.logStreamOverride?.endpoint).toBe("logs.example.test:6514");
          expect(Redacted.value(deployed.web.envVars.NODE_ENV)).toBe("staging");
          expect(deployed.priv.runtime).toBe("docker");
          expect(deployed.worker.runtime).toBe("image");
          expect(deployed.cron.schedule).toBe("0 2 * * *");
          expect(deployed.site.headers[0]?.name).toBe("Cache-Control");
          expect(deployed.site.routes[0]?.type).toBe("rewrite");

          // Update WebService (grow disk, add autoscaling, swap custom domain, move environment, clear log stream override), CronJob schedule, StaticSite routes
          const updated = yield* stack.deploy(
            Effect.gen(function* () {
              const proj = yield* Render.Project("SvcProject", {
                name: "svc-project",
                environments: {
                  staging: { name: "staging", protectedStatus: "unprotected" },
                  prod: { name: "prod", protectedStatus: "protected" },
                },
              });
              const web = yield* Render.WebService("WebApi", {
                name: "web-api",
                plan: "standard",
                region: "oregon",
                environmentId: proj.environments.prod.id,
                healthCheckPath: "/ready",
                numInstances: 2,
                autoscaling: {
                  enabled: true,
                  min: 2,
                  max: 6,
                  criteria: {
                    cpu: { enabled: true, percentage: 70 },
                    memory: { enabled: false, percentage: 80 },
                  },
                },
                disk: { name: "uploads", mountPath: "/var/data", sizeGB: 20 },
                customDomains: ["v2.example.test"],
                envVars: { NODE_ENV: "production" },
                secretFiles: { "tls.crt": "CERT_V2" },
                runtimeSource: {
                  nativeRuntime: {
                    runtime: "node",
                    repo: "https://github.com/alchemy/web-api",
                    branch: "release",
                    buildCommand: "pnpm build",
                  },
                },
                startCommand: "pnpm start:prod",
              });
              const cron = yield* Render.CronJob("NightlyJob", {
                name: "nightly-job",
                plan: "starter",
                region: "oregon",
                schedule: "30 3 * * *",
                runtimeSource: {
                  image: { imagePath: "ghcr.io/alchemy/cron", digest: "sha256:def456" },
                },
              });
              const site = yield* Render.StaticSite("MarketingSite", {
                name: "marketing-site",
                repo: "https://github.com/alchemy/marketing",
                branch: "main",
                buildCommand: "pnpm build",
                publishPath: "out",
                headers: [],
                routes: [{ source: "/old", destination: "/new", type: "redirect" }],
              });
              return { proj, web, cron, site };
            }),
          );

          expect(updated.web.id).toBe(deployed.web.id);
          expect(updated.web.environmentId).toBe(updated.proj.environments.prod.id);
          expect(updated.web.disk?.sizeGB).toBe(20);
          expect(updated.web.numInstances).toBe(2);
          expect(updated.web.autoscaling?.max).toBe(6);
          expect(updated.web.customDomains.map((d) => d.name)).toEqual(["v2.example.test"]);
          expect(updated.web.logStreamOverride).toBeUndefined();
          expect(updated.cron.schedule).toBe("30 3 * * *");
          expect(updated.site.publishPath).toBe("out");
          expect(updated.site.headers.length).toBe(0);
          expect(updated.site.routes[0]?.type).toBe("redirect");

          // Verify changing region triggers replace (new service ID) on WebService
          const replaced = yield* stack.deploy(
            Effect.gen(function* () {
              const proj = yield* Render.Project("SvcProject", {
                name: "svc-project",
                environments: {
                  staging: { name: "staging", protectedStatus: "unprotected" },
                  prod: { name: "prod", protectedStatus: "protected" },
                },
              });
              const web = yield* Render.WebService("WebApi", {
                name: "web-api",
                plan: "standard",
                region: "frankfurt",
                environmentId: proj.environments.prod.id,
                runtimeSource: {
                  nativeRuntime: {
                    runtime: "node",
                    repo: "https://github.com/alchemy/web-api",
                    branch: "release",
                    buildCommand: "pnpm build",
                  },
                },
                startCommand: "pnpm start:prod",
              });
              return { web };
            }),
          );
          expect(replaced.web.id).not.toBe(deployed.web.id);
          expect(replaced.web.region).toBe("frankfurt");

          yield* stack.destroy();
          expect(fake.snapshotCounts().services).toBe(0);
          expect(fake.snapshotCounts().disks).toBe(0);
        }),
      { tags: ["provider:render", "local"], timeout: 60_000 },
    );
  },
);
