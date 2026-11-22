import * as Render from "@alchemy.run/render";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { FakeRenderServer } from "./FakeRenderServer.ts";

describe(
  "Render Observability & Networking (Webhook, DedicatedIp, LogStream, MetricsStream, NotificationSetting)",
  { tags: ["provider:render", "local"], timeout: 60_000 },
  () => {
    const fake = new FakeRenderServer({ dedicatedIpReadyAfterPolls: 3 });
    const t = Test.make({
      providers: fake.providersLayer({ pollIntervalMs: 1, pollMaxAttempts: 15 }),
    });
    t.afterAll(Effect.sync(() => fake.stop()));

    t.test.provider(
      "reconciles Webhook, DedicatedIp (poll + replace), LogStream, MetricsStream, and NotificationSetting",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const proj = yield* Render.Project("ObsProject", {
                name: "obs-project",
                environments: {
                  prod: { name: "prod", protectedStatus: "protected" },
                },
              });

              const hook = yield* Render.Webhook("DeployEvents", {
                name: "deploy-events",
                url: "https://hooks.example.test/render",
                enabled: true,
                eventFilter: ["deploy_ended", "build_ended"],
              });

              const ip = yield* Render.DedicatedIp("OregonEgress", {
                name: "oregon-egress",
                region: "oregon",
                description: "Production egress",
                environmentIds: [proj.environments.prod.id],
              });

              const logs = yield* Render.LogStream("WorkspaceLogs", {
                endpoint: "intake.logs.example.test:6514",
                token: Redacted.make("log_secret_v1"),
                preview: "send",
              });

              const metrics = yield* Render.MetricsStream("WorkspaceMetrics", {
                provider: "GRAFANA",
                url: "https://otlp.grafana.example.test/otlp",
                token: Redacted.make("otel_secret_v1"),
              });

              const notify = yield* Render.NotificationSetting("WorkspaceNotify", {
                emailEnabled: true,
                notificationsToSend: "failure",
                previewNotificationsEnabled: false,
              });

              return { proj, hook, ip, logs, metrics, notify };
            }),
          );

          expect(deployed.hook.enabled).toBe(true);
          expect(deployed.hook.eventFilter).toEqual(["deploy_ended", "build_ended"]);
          expect(Redacted.value(deployed.hook.secret)).toContain("whsec-");

          expect(deployed.ip.status).toBe("RUNNING");
          expect(deployed.ip.ips.length).toBeGreaterThan(0);

          expect(deployed.logs.endpoint).toBe("intake.logs.example.test:6514");
          expect(deployed.logs.preview).toBe("send");
          expect(Redacted.value(deployed.logs.token!)).toBe("log_secret_v1");

          expect(deployed.metrics.provider).toBe("GRAFANA");
          expect(deployed.metrics.url).toBe("https://otlp.grafana.example.test/otlp");
          expect(Redacted.value(deployed.metrics.token!)).toBe("otel_secret_v1");

          expect(deployed.notify.emailEnabled).toBe(true);
          expect(deployed.notify.notificationsToSend).toBe("failure");
          expect(deployed.notify.previewNotificationsEnabled).toBe(false);

          // Confirm DedicatedIp polled across multiple GET checks
          const dipGetCalls = fake.calls.filter(
            (c) => c.method === "GET" && c.path === `/dedicated-ips/${deployed.ip.id}`,
          );
          expect(dipGetCalls.length).toBeGreaterThanOrEqual(3);

          // Verify lookup & list across all 5 resource types
          const hookProv = yield* Provider.findProvider(Render.Webhook);
          const ipProv = yield* Provider.findProvider(Render.DedicatedIp);
          const logProv = yield* Provider.findProvider(Render.LogStream);
          const metricsProv = yield* Provider.findProvider(Render.MetricsStream);
          const notifyProv = yield* Provider.findProvider(Render.NotificationSetting);

          expect((yield* hookProv.lookup!({ name: "deploy-events" }))?.id).toBe(deployed.hook.id);
          expect((yield* hookProv.list!()).length).toBe(1);
          expect((yield* ipProv.lookup!({ name: "oregon-egress" }))?.id).toBe(deployed.ip.id);
          expect((yield* ipProv.list!()).length).toBe(1);
          expect((yield* logProv.lookup!({}))?.endpoint).toBe("intake.logs.example.test:6514");
          expect((yield* metricsProv.lookup!({}))?.provider).toBe("GRAFANA");
          expect((yield* notifyProv.lookup!({}))?.notificationsToSend).toBe("failure");

          // Update resources in place & replace DedicatedIp on region change
          const updated = yield* stack.deploy(
            Effect.gen(function* () {
              const proj = yield* Render.Project("ObsProject", {
                name: "obs-project",
                environments: {
                  prod: { name: "prod", protectedStatus: "protected" },
                },
              });

              const hook = yield* Render.Webhook("DeployEvents", {
                name: "deploy-events-v2",
                url: "https://hooks.example.test/render-v2",
                enabled: false,
                eventFilter: [],
              });

              const ip = yield* Render.DedicatedIp("OregonEgress", {
                name: "oregon-egress",
                region: "frankfurt",
                description: "EU egress",
                environmentIds: [proj.environments.prod.id],
              });

              const logs = yield* Render.LogStream("WorkspaceLogs", {
                endpoint: "eu-logs.example.test:6514",
                token: Redacted.make("log_secret_v2"),
                preview: "drop",
              });

              const metrics = yield* Render.MetricsStream("WorkspaceMetrics", {
                provider: "DATADOG",
                url: "https://api.datadoghq.example.test/otlp",
                token: Redacted.make("otel_secret_v2"),
              });

              const notify = yield* Render.NotificationSetting("WorkspaceNotify", {
                emailEnabled: false,
                notificationsToSend: "all",
                previewNotificationsEnabled: true,
              });

              return { hook, ip, logs, metrics, notify };
            }),
          );

          expect(updated.hook.id).toBe(deployed.hook.id);
          expect(updated.hook.enabled).toBe(false);
          expect(updated.hook.name).toBe("deploy-events-v2");
          expect(updated.ip.id).not.toBe(deployed.ip.id);
          expect(updated.ip.region).toBe("frankfurt");
          expect(updated.logs.preview).toBe("drop");
          expect(updated.metrics.provider).toBe("DATADOG");
          expect(updated.notify.notificationsToSend).toBe("all");
          expect(updated.notify.emailEnabled).toBe(false);

          yield* stack.destroy();
          expect(fake.snapshotCounts().webhooks).toBe(0);
          expect(fake.snapshotCounts().dedicatedIps).toBe(0);
          expect(fake.snapshotCounts().ownerLogStreams).toBe(0);
          expect(fake.snapshotCounts().metricsStreams).toBe(0);
          expect(fake.snapshotCounts().projects).toBe(0);
        }),
      { tags: ["provider:render", "local"], timeout: 60_000 },
    );
  },
);

describe(
  "Render DedicatedIp Terminal Failure",
  { tags: ["provider:render", "local"], timeout: 60_000 },
  () => {
    const fake = new FakeRenderServer({
      dedicatedIpReadyAfterPolls: 2,
      dedicatedIpTerminalStatus: "FAILED",
    });
    const t = Test.make({
      providers: fake.providersLayer({ pollIntervalMs: 1, pollMaxAttempts: 10 }),
    });
    t.afterAll(Effect.sync(() => fake.stop()));

    t.test.provider(
      "fails with RenderDeployFailedError when DedicatedIp enters FAILED status",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const err = yield* stack
            .deploy(
              Effect.gen(function* () {
                return yield* Render.DedicatedIp("FailedEgress", {
                  name: "failed-egress",
                  region: "oregon",
                });
              }),
            )
            .pipe(Effect.flip);
          expect(JSON.stringify(err)).toContain("RenderDeployFailedError");
          yield* stack.destroy();
        }),
      { tags: ["provider:render", "local"], timeout: 60_000 },
    );
  },
);
