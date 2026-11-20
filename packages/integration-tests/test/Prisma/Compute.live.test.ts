import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Prisma from "@alchemy.run/prisma";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import {
  createServiceRollback,
  getDeployment,
  getProject,
  getService,
} from "@distilled.cloud/prisma/management";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { doWork, OtelCollector, waitForWorkSpan, withCollectorUrl } from "../Utils/Telemetry.ts";
import EffectNativeCompute from "./fixtures/effect-native-compute.ts";
import TracedCompute from "./fixtures/traced-compute.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Prisma.providers(), Cloudflare.providers()),
});

// Manual recovery tool for a Compute app whose destroy failed; not part of the suite.
const runCleanup =
  process.env.ALCHEMY_RUN_LIVE_PRISMA_CLEANUP === "true" &&
  !!process.env.PRISMA_CLEANUP_PROJECT_ID?.trim();

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

test.provider.skipIf(!runCleanup)(
  "live cleans up an existing Prisma Compute project/App from configured credentials",
  () =>
    Effect.gen(function* () {
      const projectId = process.env.PRISMA_CLEANUP_PROJECT_ID!.trim();
      const appId = process.env.PRISMA_CLEANUP_APP_ID?.trim() || undefined;
      const deploymentId = process.env.PRISMA_CLEANUP_DEPLOYMENT_ID?.trim() || undefined;

      if (deploymentId) {
        yield* Prisma.destroyComputeVersion(deploymentId, {
          timeoutSeconds: 240,
        });
      }
      yield* Prisma.destroyProjectComputeServices(projectId, {
        timeoutSeconds: 240,
      });

      yield* expectGone("Prisma project", Prisma.getProject(projectId));
      if (appId) {
        yield* expectGone("Prisma App", Prisma.getApp(appId));
      }
    }).pipe(logLevel),
  {
    tags: ["provider:prisma", "provider:prisma:compute", "live"],
    timeout: 600_000,
  },
);

test.provider(
  "live deploys, reaches, and destroys a Prisma Compute app",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const appDir = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-",
      });
      yield* fs.writeFileString(
        path.join(appDir, "package.json"),
        ["{", '  "type": "module",', '  "main": "server.ts"', "}", ""].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(appDir, "server.ts"),
        [
          'const port = Number(process.env["PORT"] ?? "8080");',
          "const server = Bun.serve({",
          "  port,",
          "  routes: {",
          '    "/": new Response(process.env["GREETING"] ?? "missing"),',
          '    "/health": Response.json({ ok: true }),',
          "  },",
          "});",
          "console.log(`Listening on ${server.url}`);",
          "export {};",
          "",
        ].join("\n"),
      );

      yield* stack.destroy();

      let deployed:
        | {
            projectId: string;
            appId: string;
            deploymentId: string;
          }
        | undefined;

      yield* Effect.gen(function* () {
        const output = yield* stack.deploy(
          Effect.gen(function* () {
            const project = yield* Prisma.Project("Project", {
              createDatabase: false,
            });
            const app = yield* Prisma.Compute("App", {
              project: project.projectId,
              path: appDir,
              entrypoint: "server.ts",
              port: 8080,
              env: {
                GREETING: "hello from alchemy",
              },
              timeoutSeconds: 240,
              destroyOldDeployment: true,
            });
            return { project, app };
          }),
        );

        expect(output.project.projectId).toBeDefined();
        expect(output.app.serviceId).toBeDefined();
        expect(output.app.versionId).toBeDefined();
        expect(output.app.url).toBeDefined();
        deployed = {
          projectId: output.project.projectId,
          appId: output.app.serviceId,
          deploymentId: output.app.versionId!,
        };

        const text = yield* fetchText(`${output.app.url}/`);
        expect(text).toBe("hello from alchemy");
        yield* stack
          .destroy()
          .pipe(
            Effect.mapError(
              (error) =>
                new Error(
                  [
                    "Prisma Compute live smoke deployed successfully but destroy failed.",
                    `projectId=${deployed?.projectId}`,
                    `appId=${deployed?.appId}`,
                    `deploymentId=${deployed?.deploymentId}`,
                    deployed
                      ? [
                          "Retry cleanup after the platform fix with:",
                          `PRISMA_CLEANUP_PROJECT_ID=${deployed.projectId} \\`,
                          `PRISMA_CLEANUP_APP_ID=${deployed.appId} \\`,
                          `PRISMA_CLEANUP_DEPLOYMENT_ID=${deployed.deploymentId} \\`,
                          "ALCHEMY_RUN_LIVE_PRISMA_CLEANUP=true pnpm test test/Prisma/Compute.live.test.ts --profile testing",
                        ].join(" ")
                      : undefined,
                  ]
                    .filter((line): line is string => line !== undefined)
                    .join(" "),
                  { cause: error },
                ),
            ),
          );
        yield* expectGone("Prisma project", Prisma.getProject(deployed.projectId));
        yield* expectGone("Prisma App", Prisma.getApp(deployed.appId));
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* stack.destroy().pipe(Effect.ignore);
            yield* fs.remove(appDir, { recursive: true }).pipe(Effect.ignore);
          }),
        ),
      );
    }).pipe(logLevel),
  {
    tags: ["provider:prisma", "provider:prisma:compute", "provider:prisma:project", "live"],
    timeout: 600_000,
  },
);

test.provider(
  "live deploys, serves, and destroys a Prisma static site",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* path.fromFileUrl(
        new URL("./fixtures/compute-static-live/", import.meta.url),
      );
      const nodeModules = yield* path.fromFileUrl(new URL("../../node_modules/", import.meta.url));
      const appDir = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-prisma-static-site-",
      });
      yield* fs.copy(fixture, appDir);
      yield* fs.symlink(nodeModules, path.join(appDir, "node_modules"));

      const deploy = (version: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const project = yield* Prisma.Project("Project", {
              createDatabase: false,
            });
            const site = yield* Prisma.Compute("Site", {
              project: project.projectId,
              path: appDir,
              build: {
                type: "auto",
                env: { VITE_SITE_VERSION: version },
                timeoutSeconds: 30,
              },
              healthCheck: { path: "/" },
              timeoutSeconds: 45,
              destroyOldDeployment: true,
            });
            return { project, site };
          }),
        );

      const verifySite = Effect.fn(function* (url: string, version: string) {
        const origin = url.replace(/\/$/, "");
        const index = yield* fs.readFileString(path.join(appDir, "dist/index.html"));
        const script = yield* fs.readFileString(path.join(appDir, "dist/assets/app.js"));
        const scriptStat = yield* fs.stat(path.join(appDir, "dist/assets/app.js"));
        const docs = yield* fs.readFileString(path.join(appDir, "dist/docs/index.html"));
        const docsStyle = yield* fs.readFileString(path.join(appDir, "dist/docs/style.css"));
        expect(index).toContain("alchemy static shell");
        expect(index).toContain(`<p id="version">${version}</p>`);
        expect(script).toContain("alchemy static asset");

        yield* Effect.gen(function* () {
          const response = yield* HttpClient.get(`${origin}/`);
          const text = yield* response.text;
          if (response.status !== 200 || text !== index) {
            return yield* Effect.fail(
              new Error(`Static site ${version} is not ready (HTTP ${response.status})`),
            );
          }
        }).pipe(
          Effect.timeout("3 seconds"),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 8 }),
          Effect.timeout("15 seconds"),
        );

        const asset = yield* HttpClient.get(`${origin}/assets/app.js`);
        expect(asset.status).toBe(200);
        expect(asset.headers["content-type"]).toContain("javascript");
        expect(yield* asset.text).toBe(script);
        const head = yield* HttpClient.head(`${origin}/assets/app.js`);
        expect(head.status).toBe(200);
        expect(head.headers["content-length"]).toBe(String(scriptStat.size));
        expect(yield* head.text).toBe("");
        const route = yield* HttpClient.get(`${origin}/client/route`);
        expect(route.status).toBe(200);
        expect(yield* route.text).toBe(index);

        const query = "?from=%2Fclient%2Froute&next=%2F%2Fevil.example";
        for (const pathname of ["/docs", "//docs"]) {
          const redirect = yield* HttpClient.get(`${origin}${pathname}${query}`);
          expect(redirect.status).toBe(301);
          expect(redirect.headers["location"]).toBe(`/docs/${query}`);
          const target = yield* Effect.sync(() => new URL(redirect.headers["location"]!, origin));
          expect(target.origin).toBe(origin);
          expect(target.search).toBe(query);
          expect(decodeURIComponent(target.pathname).replace(/^\/+/, "/")).toBe("/docs/");
          yield* redirect.text;
          const directory = yield* HttpClient.get(target.href);
          expect(directory.status).toBe(200);
          expect(yield* directory.text).toBe(docs);
          const relativeAsset = yield* Effect.sync(() => new URL("./style.css", target).href);
          const stylesheet = yield* HttpClient.get(relativeAsset);
          expect(stylesheet.status).toBe(200);
          expect(stylesheet.headers["content-type"]).toContain("text/css");
          expect(yield* stylesheet.text).toBe(docsStyle);
        }
      });

      yield* stack.destroy();
      yield* Effect.gen(function* () {
        const output = yield* deploy("v1");
        expect(output.site.url).toBeDefined();
        expect(output.site.versionId).toBeDefined();
        expect((yield* getProject({ id: output.project.projectId })).data.id).toBe(
          output.project.projectId,
        );
        expect((yield* getService({ serviceId: output.site.serviceId })).data.id).toBe(
          output.site.serviceId,
        );
        yield* verifySite(output.site.url!, "v1").pipe(
          Effect.timeout("20 seconds"),
          Effect.provideService(FetchHttpClient.RequestInit, {
            redirect: "manual",
            cache: "no-store",
          }),
          Effect.provide(FetchHttpClient.layer),
        );

        const updated = yield* deploy("v2");
        expect(updated.project.projectId).toBe(output.project.projectId);
        expect(updated.site.serviceId).toBe(output.site.serviceId);
        expect(updated.site.url).toBe(output.site.url);
        expect(updated.site.versionId).toBeDefined();
        expect(updated.site.versionId).not.toBe(output.site.versionId);
        expect((yield* getService({ serviceId: updated.site.serviceId })).data.id).toBe(
          updated.site.serviceId,
        );
        yield* verifySite(updated.site.url!, "v2").pipe(
          Effect.timeout("20 seconds"),
          Effect.provideService(FetchHttpClient.RequestInit, {
            redirect: "manual",
            cache: "no-store",
          }),
          Effect.provide(FetchHttpClient.layer),
        );

        yield* stack.destroy();
        const projectGone = yield* getProject({
          id: output.project.projectId,
        }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
          Effect.repeat({
            until: (gone) => gone,
            schedule: Schedule.spaced("500 millis"),
            times: 8,
          }),
          Effect.timeout("10 seconds"),
        );
        const appGone = yield* getService({
          serviceId: output.site.serviceId,
        }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
          Effect.repeat({
            until: (gone) => gone,
            schedule: Schedule.spaced("500 millis"),
            times: 8,
          }),
          Effect.timeout("10 seconds"),
        );
        expect(projectGone).toBe(true);
        expect(appGone).toBe(true);
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)));
    }).pipe(logLevel),
  {
    tags: ["provider:prisma", "provider:prisma:compute", "provider:prisma:project", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "live deploys a changed source as a new version, keeps the first, and the platform rolls back to it",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const appDir = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-rollback-",
      });
      const writeServer = (text: string) =>
        fs.writeFileString(
          path.join(appDir, "server.ts"),
          [
            'const port = Number(process.env["PORT"] ?? "8080");',
            "const server = Bun.serve({",
            "  port,",
            "  routes: {",
            `    "/": new Response(${JSON.stringify(text)} + " " + (process.env["GREETING"] ?? "missing")),`,
            '    "/health": Response.json({ ok: true }),',
            "  },",
            "});",
            "console.log(`Listening on ${server.url}`);",
            "export {};",
            "",
          ].join("\n"),
        );
      const program = Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", {
          createDatabase: false,
        });
        const app = yield* Prisma.Compute("App", {
          project: project.projectId,
          path: appDir,
          entrypoint: "server.ts",
          port: 8080,
          env: { GREETING: "hello" },
          timeoutSeconds: 240,
        });
        return { project, app };
      });

      yield* stack.destroy();

      yield* Effect.gen(function* () {
        yield* writeServer("first");
        const first = yield* stack.deploy(program);
        expect(first.app.activeVersionId).toBe(first.app.versionId);
        expect(yield* fetchUntil(`${first.app.url}/`, "first hello")).toBe("first hello");

        yield* writeServer("second");
        const second = yield* stack.deploy(program);
        expect(second.app.serviceId).toBe(first.app.serviceId);
        expect(second.app.url).toBe(first.app.url);
        expect(second.app.versionId).not.toBe(first.app.versionId);
        expect(yield* fetchUntil(`${second.app.url}/`, "second hello")).toBe("second hello");
        const kept = yield* getDeployment({ deploymentId: first.app.versionId! });
        expect(kept.data.serviceId).toBe(first.app.serviceId);

        yield* createServiceRollback({
          serviceId: first.app.serviceId,
          deploymentId: first.app.versionId!,
        });
        expect(yield* fetchUntil(`${first.app.url}/`, "first hello")).toBe("first hello");

        yield* stack.destroy();
        const projectGone = yield* getProject({
          id: first.project.projectId,
        }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        );
        const appGone = yield* getService({ serviceId: first.app.serviceId }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        );
        expect(projectGone).toBe(true);
        expect(appGone).toBe(true);
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* stack.destroy().pipe(Effect.ignore);
            yield* fs.remove(appDir, { recursive: true }).pipe(Effect.ignore);
          }),
        ),
      );
    }).pipe(logLevel),
  {
    tags: ["provider:prisma", "provider:prisma:compute", "provider:prisma:project", "live"],
    timeout: 240_000,
  },
);

test.provider(
  "live serves an Effect-native Compute whose init binds a variable",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = yield* stack.deploy(EffectNativeCompute);
      expect(app.environmentKeys).toEqual(["GREETING"]);
      expect(yield* fetchUntil(`${app.url}/`, "from a binding")).toBe("from a binding");

      yield* stack.destroy();
      const appGone = yield* getService({ serviceId: app.serviceId }).pipe(
        Effect.as(false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
      );
      expect(appGone).toBe(true);
      yield* expectGone("Prisma project", Prisma.getProject(app.projectId));
    }).pipe(logLevel),
  {
    tags: ["provider:prisma", "provider:prisma:compute", "provider:prisma:project", "live"],
    timeout: 600_000,
  },
);

test.provider(
  "live Compute app exports spans to the bound OTLP destination",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // The traced program binds the collector url at deploy, so it deploys first.
      const collector = yield* stack.deploy(OtelCollector());
      const app = yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* OtelCollector();
            return yield* TracedCompute;
          }),
        )
        .pipe(withCollectorUrl(collector.url!));

      expect(yield* doWork(app.url!, "prisma")).toBe("did work prisma");
      const traces = yield* waitForWorkSpan(collector.url!, "prisma");
      expect(traces).toContain("work:prisma");
      expect(traces).toContain("prisma-compute-e2e");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:prisma",
      "provider:prisma:compute",
      "provider:prisma:project",
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 600_000,
  },
);

const fetchText = (url: string) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(HttpClientRequest.get(url));
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(new Error(`Prisma Compute app returned HTTP ${response.status}`));
    }
    return yield* response.text;
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.exponential(Duration.seconds(1)), Schedule.recurs(8)]),
    }),
  );

/** Poll a URL until it answers `expected`, for at most about two minutes. */
const fetchUntil = (url: string, expected: string) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(HttpClientRequest.get(url));
    const text = yield* response.text;
    if (response.status !== 200 || text !== expected) {
      return yield* Effect.fail(
        new Error(`${url} answered HTTP ${response.status} '${text.slice(0, 80)}'`),
      );
    }
    return text;
  }).pipe(Effect.retry({ schedule: Schedule.spaced(Duration.seconds(3)), times: 40 }));

const expectGone = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const gone = yield* effect.pipe(
      Effect.as(false),
      Effect.catchIf(Prisma.isNotFound, () => Effect.succeed(true)),
    );
    if (!gone) return yield* Effect.fail(new Error(`${label} still exists`));
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.exponential(Duration.seconds(1)), Schedule.recurs(8)]),
    }),
  );
