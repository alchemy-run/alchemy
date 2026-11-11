import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Daytona from "@alchemy.run/daytona";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { BindingsCache, DevBox } from "./resources.ts";
import * as Toolbox from "./toolbox.ts";

export default class DaytonaWorker extends Cloudflare.Worker<DaytonaWorker>()(
  "DaytonaWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const sandboxes = yield* Daytona.CreateSandbox();
    const devBox = yield* Daytona.ConnectSandbox(DevBox);
    const volumes = yield* Daytona.CreateVolume({ prefix: "alchemy-bindings-" });
    const cache = yield* Daytona.MountVolume(BindingsCache, { path: "/cache" });
    const secrets = yield* Daytona.CreateSecret();
    const images = yield* Daytona.CreateSnapshot();
    const organization = yield* Daytona.ReadOrganization();
    const usage = yield* Daytona.ReadUsage();
    const audit = yield* Daytona.ReadAuditLogs();
    const http = yield* HttpClient.HttpClient;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const prefix = url.searchParams.get("prefix") ?? "test";

        if (url.pathname === "/create-sandbox") {
          const sandbox = yield* Effect.acquireRelease(
            sandboxes.create({
              name: `alchemy-bindings-${prefix}`,
              labels: { purpose: "bindings-test" },
            }),
            (s) => sandboxes.delete(s.sandboxId).pipe(Effect.ignore),
          );
          const echo = yield* sandbox.exec("echo hello > /tmp/greeting && cat /tmp/greeting");
          const info = yield* sandbox.fs.getFileInfo({ path: "/tmp/greeting" });
          const found = yield* sandboxes.get(sandbox.name);
          // The list lags creation by a few seconds.
          const listed = yield* sandboxes.list({ labels: { purpose: "bindings-test" } }).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              until: (all) => all.some((s) => s.id === sandbox.sandboxId),
              times: 15,
            }),
          );
          return yield* HttpServerResponse.json({
            echo,
            size: info.size,
            found: found?.sandboxId === sandbox.sandboxId,
            listed: listed.some((s) => s.id === sandbox.sandboxId),
          });
        }

        // Objects a binding creates carry the host's alchemy.* labels (a
        // sandbox) or stack/stage/id in their description (a secret). The
        // test reads them out of band and deletes them itself.
        if (url.pathname === "/tagged") {
          const sandbox = yield* sandboxes.create({
            name: `alchemy-tagged-${prefix}`,
            // A user label can't overwrite an owner label.
            labels: { purpose: "tag-test", "alchemy.id": "not-the-host" },
            autoDeleteInterval: 30,
          });
          const secret = yield* secrets.put({
            name: `alchemy-tagged-${prefix}`,
            value: "tagged",
            description: "tag test",
          });
          return yield* HttpServerResponse.json({
            sandboxId: sandbox.sandboxId,
            secret: secret.name,
          });
        }

        // getTcpPort, server form: forward this request to the echo server.
        if (url.pathname.startsWith("/proxy/")) {
          const port = yield* Toolbox.ensureEchoServer(devBox);
          return yield* port.fetch(request);
        }

        if (url.pathname.startsWith("/toolbox/")) {
          const run = {
            files: Toolbox.files,
            processes: Toolbox.processes,
            git: Toolbox.git,
            lsp: Toolbox.lsp,
            system: Toolbox.system,
            "git-remote": Toolbox.gitRemote,
            sessions: Toolbox.sessions,
            streams: Toolbox.streams,
            bulk: Toolbox.bulk,
            vocabulary: Toolbox.vocabulary,
            "port-client": Toolbox.portClient,
          }[url.pathname.slice("/toolbox/".length)];
          if (run === undefined) return HttpServerResponse.text("not found", { status: 404 });
          return yield* HttpServerResponse.json(yield* run(devBox, prefix));
        }

        if (url.pathname === "/sandbox-lifecycle") {
          // Mount a declared volume (through MountVolume) and one created at runtime.
          const home = yield* volumes.getOrCreate({ name: `alchemy-bindings-home-${prefix}` });
          const sandbox = yield* Effect.acquireRelease(
            sandboxes.create({
              name: `alchemy-lifecycle-${prefix}`,
              labels: { purpose: "lifecycle-test" },
              mounts: [cache, { volume: home, path: "/home/daytona/work" }],
            }),
            (s) => sandboxes.delete(s.sandboxId).pipe(Effect.ignore),
          );
          const cacheId = yield* Daytona.volumeIdOf(cache.volume);
          const mounted = ((yield* sandbox.getSandbox()).volumes ?? [])
            .map((v) => [
              v.mountPath,
              v.volumeId === (v.mountPath === "/cache" ? cacheId : home.volumeId),
            ])
            .sort();
          const writable = yield* sandbox.exec("touch /cache/ok /home/daytona/work/ok && echo ok");
          // Serve a page on a port and reach it through a signed preview URL.
          yield* sandbox.process.createSession({ sessionId: "web" });
          yield* sandbox.exec("mkdir -p /tmp/site && echo signed-ok > /tmp/site/index.html");
          yield* sandbox.process.sessionExecuteCommand({
            sessionId: "web",
            command: "cd /tmp/site && python3 -m http.server 8080",
            runAsync: true,
          });
          yield* sandbox.ports.isPortInUse({ port: 8080 }).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              until: (r) => r.isInUse === true,
              times: 15,
            }),
          );
          const signed = yield* sandbox.getSignedPortPreviewUrl({
            port: 8080,
            expiresInSeconds: 120,
          });
          const page = yield* http
            .get(signed.url)
            .pipe(Effect.flatMap((r) => Effect.map(r.text, (body) => ({ status: r.status, body }))))
            .pipe(
              Effect.repeat({
                schedule: Schedule.spaced("1 second"),
                until: (r) => r.status === 200,
                times: 10,
              }),
            );
          yield* sandbox.expireSignedPortPreviewUrl({ port: 8080, token: signed.token });

          const ssh = yield* sandbox.createSshAccess({ expiresInMinutes: 5 });
          yield* sandbox.revokeSshAccess({ token: ssh.token });

          const key = yield* sandbox.getSandboxSigningKey();
          const rotated = yield* sandbox.rotateSigningKey();

          const fork = yield* sandbox
            .forkSandbox({ name: `alchemy-fork-${prefix}` })
            .pipe(Effect.flip);

          const pause = yield* sandbox.pauseSandbox().pipe(Effect.flip);

          // Settings through the handle.
          // Replacing labels keeps the ones the binding tracks its sandboxes by.
          const labelled = yield* sandbox.getSandbox();
          yield* sandbox.replaceLabels({ labels: { ...labelled.labels, step: "two" } });
          yield* sandbox.setAutostopInterval({ interval: 20 });
          yield* sandbox.setAutoArchiveInterval({ interval: 60 * 24 });
          yield* sandbox.setAutoDeleteInterval({ interval: 60 });
          yield* sandbox.setTtl({ ttlMinutes: 120 });
          yield* sandbox.updatePublicStatus({ isPublic: true });
          const configured = yield* sandbox.getSandbox();
          const autoPause = yield* sandbox.setAutoPauseInterval({ interval: 30 }).pipe(
            Effect.flip,
            Effect.map((e) => e._tag),
          );
          const resize = yield* sandbox.resizeSandbox({ cpu: 2 }).pipe(
            Effect.flip,
            Effect.map((e) => e._tag),
          );

          // Reads: quota, lineage, logs, metrics, traces, telemetry.
          const to = new Date().toISOString();
          const from = new Date(Date.now() - 3_600_000).toISOString();
          const ancestors = yield* sandbox.getSandboxAncestors();
          // Region quota by sandbox is served to Daytona's runners, not API keys.
          const regionQuota = yield* sandbox.getRegionQuotaBySandboxId().pipe(
            Effect.flip,
            Effect.map((e) => e._tag),
          );
          // Re-initializing the daemon sets its auth token; the toolbox keeps working.
          const initialized = yield* sandbox.server.initialize({ token: `alchemy-${prefix}` });
          const afterInit = yield* sandbox.exec("echo init-ok");
          // Daytona Cloud serves telemetry from its Analytics API (below); the
          // sandbox-scoped endpoints are switched off.
          const legacyTelemetry = yield* sandbox.getSandboxLogs({ from, to }).pipe(
            Effect.flip,
            Effect.map((e) => e._tag),
          );
          const buildLogs = yield* sandbox.getBuildLogsUrl().pipe(
            Effect.result,
            Effect.map((r) => (r._tag === "Success" ? "url" : r.failure._tag)),
          );
          const telemetryLogs = yield* sandbox.telemetry.listOrganizationSandboxTelemetryLogs({
            from,
            to,
          });
          const telemetryMetrics = yield* sandbox.telemetry.listOrganizationSandboxTelemetryMetrics(
            { from, to },
          );
          const telemetryTraces = yield* sandbox.telemetry.listOrganizationSandboxTelemetryTraces({
            from,
            to,
          });

          // Stop and start through the handle.
          yield* sandbox.stopSandbox();
          const stopped = yield* sandbox.getSandbox().pipe(
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              until: (s) => s.state === "stopped",
              times: 60,
            }),
          );
          yield* sandbox.startSandbox();
          const restarted = yield* sandbox.getSandbox().pipe(
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              until: (s) => s.state === "started",
              times: 60,
            }),
          );

          return yield* HttpServerResponse.json({
            page: { status: page.status, body: page.body.trim() },
            ssh: ssh.sshCommand.includes("ssh"),
            key: typeof key === "string" && key.length > 0,
            rotated: rotated !== undefined,
            fork: fork._tag,
            pause: pause._tag,
            configured: {
              step: configured.labels.step,
              kept: Object.keys(labelled.labels).every((k) => k in configured.labels),
              autoStop: configured.autoStopInterval,
              autoArchive: configured.autoArchiveInterval,
              autoDelete: configured.autoDeleteInterval,
              ttl: configured.autoDestroyAt !== undefined,
              public: configured.public,
            },
            autoPause,
            resize,
            ancestors: Array.isArray(ancestors),
            mounted,
            writable: writable.result.trim(),
            regionQuota,
            initialized: Object.values(initialized).some((m) => m?.includes("initialized")),
            afterInit: afterInit.result.trim(),
            legacyTelemetry,
            buildLogs,
            telemetry: [telemetryLogs, telemetryMetrics, telemetryTraces].every(
              (r) => r !== undefined,
            ),
            cycle: [stopped.state, restarted.state],
          });
        }

        if (url.pathname === "/create-sandbox-resources") {
          // A snapshot sizes the sandbox; Daytona refuses resources on create.
          const error = yield* sandboxes
            .create({ name: `alchemy-resources-${prefix}`, cpu: 2 })
            .pipe(Effect.flip);
          return yield* HttpServerResponse.json({ error: error._tag });
        }

        if (url.pathname === "/computer-use") {
          const sandbox = yield* Effect.acquireRelease(
            sandboxes.create({
              name: `alchemy-desktop-${prefix}`,
              labels: { purpose: "computer-use-test" },
            }),
            (s) => sandboxes.delete(s.sandboxId).pipe(Effect.ignore),
          );
          return yield* HttpServerResponse.json(yield* Toolbox.desktop(sandbox));
        }

        if (url.pathname === "/connect-sandbox") {
          const uname = yield* devBox.exec("uname -s");
          const workDir = yield* devBox.info.getWorkDir();
          const preview = yield* devBox.getPortPreviewUrl({ port: 3000 });
          return yield* HttpServerResponse.json({
            uname,
            workDir,
            previewUrl: preview.url,
            identity: {
              id: typeof (yield* devBox.sandboxId),
              name: yield* devBox.name,
              toolbox: (yield* devBox.toolboxProxyUrl).startsWith("https://"),
            },
          });
        }

        if (url.pathname === "/volume") {
          const name = `alchemy-bindings-${prefix}`;
          const created = yield* volumes.getOrCreate({ name });
          const again = yield* volumes.getOrCreate({ name });
          const outside = yield* volumes
            .getOrCreate({ name: `elsewhere-${prefix}` })
            .pipe(Effect.flip);
          const listed = yield* volumes.list();
          yield* volumes.delete(created.volumeId);
          const after = yield* volumes.get(name);
          return yield* HttpServerResponse.json({
            same: created.volumeId === again.volumeId,
            state: created.state,
            rejected: outside._tag,
            listed: listed.some((v) => v.volumeId === created.volumeId),
            deleted: after === undefined,
          });
        }

        if (url.pathname === "/secret") {
          const name = `alchemy-bindings-${prefix}`;
          const first = yield* secrets.put({ name, value: "one", hosts: ["api.github.com"] });
          const second = yield* secrets.put({ name, value: "two", hosts: ["api.github.com"] });
          const found = yield* secrets.get(name);
          yield* secrets.delete(name);
          const after = yield* secrets.get(name);
          return yield* HttpServerResponse.json({
            same: first.secretId === second.secretId,
            placeholder: first.placeholder !== "",
            found: found?.secretId === first.secretId,
            deleted: after === undefined,
          });
        }

        if (url.pathname === "/snapshot") {
          const missing = yield* images.get(`alchemy-bindings-missing-${prefix}`);
          const listed = yield* images.list({ limit: 5 });
          return yield* HttpServerResponse.json({
            missing: missing === undefined,
            listed: Array.isArray(listed),
          });
        }

        if (url.pathname === "/organization") {
          const regions = yield* organization.listSharedRegions();
          const classes = yield* organization.listAvailableSandboxClasses();
          const overview = yield* organization.getOrganizationUsageOverview();
          const gpus = yield* organization.getGpuCapacity();
          const webhooks = yield* organization.getWebhookControllerInitializationStatus();
          const portal = yield* organization.getWebhookControllerAppPortalAccess();
          return yield* HttpServerResponse.json({
            regions: regions.length,
            classes: classes.length,
            quota: overview.regionUsage.length,
            gpus: gpus.capacity.length,
            webhooks: webhooks !== undefined,
            portal: typeof portal.url,
          });
        }

        if (url.pathname === "/usage") {
          const to = new Date().toISOString();
          const from = new Date(Date.now() - 86_400_000).toISOString();
          const total = yield* usage.getOrganizationUsageAggregated({ from, to });
          const chart = yield* usage.listOrganizationUsageChart({ from, to });
          const perSandbox = yield* usage.listOrganizationUsageSandbox({ from, to });
          const box = yield* usage.listOrganizationSandboxUsage({
            sandboxId: yield* devBox.sandboxId,
            from,
            to,
          });
          return yield* HttpServerResponse.json({
            total: total !== undefined,
            chart: Array.isArray(chart),
            perSandbox: Array.isArray(perSandbox),
            box: box !== undefined,
          });
        }

        if (url.pathname === "/audit") {
          const page = yield* audit.getOrganizationAuditLogs({ limit: 5 });
          const scenarios = yield* audit.getAuditScenarios();
          return yield* HttpServerResponse.json({
            items: page.items.length,
            scenarios: scenarios !== undefined,
          });
        }

        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(
        Effect.scoped,
        // Answer failures and defects with the cause so a failing test shows it.
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Daytona.CreateSandboxHttp,
        Daytona.ConnectSandboxHttp,
        Daytona.CreateVolumeHttp,
        Daytona.MountVolumeLive,
        Daytona.CreateSecretHttp,
        Daytona.CreateSnapshotHttp,
        Daytona.ReadOrganizationHttp,
        Daytona.ReadUsageHttp,
        Daytona.ReadAuditLogsHttp,
      ),
    ),
  ),
) {}
