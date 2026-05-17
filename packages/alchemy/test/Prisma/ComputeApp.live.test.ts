import * as Prisma from "@/Prisma";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

const { test } = Test.make({ providers: Prisma.providers() });

const wantsLive = process.env.ALCHEMY_RUN_LIVE_PRISMA_TESTS === "true";
const hasLiveCredentials =
  !!process.env.PRISMA_SERVICE_TOKEN?.trim() ||
  !!process.env.PRISMA_API_TOKEN?.trim() ||
  process.env.ALCHEMY_RUN_LIVE_PRISMA_WITH_PROFILE === "true";
const runLive = wantsLive && hasLiveCredentials;
const wantsCleanup =
  process.env.ALCHEMY_RUN_LIVE_PRISMA_CLEANUP === "true" &&
  !!process.env.PRISMA_CLEANUP_PROJECT_ID?.trim();
const runCleanup = wantsCleanup && hasLiveCredentials;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

if (wantsLive && !hasLiveCredentials) {
  test(
    "requires Prisma credentials for the live ComputeApp smoke",
    Effect.fail(
      new Error(
        [
          "Live Prisma Compute smoke requested but no credentials are configured.",
          "Set PRISMA_SERVICE_TOKEN, set PRISMA_API_TOKEN, or run `alchemy login --configure` and select `Service Token`,",
          "then use `bun run --cwd examples/prisma-compute test:live:profile`.",
        ].join(" "),
      ),
    ),
  );
}

if (wantsCleanup && !hasLiveCredentials) {
  test(
    "requires Prisma credentials for existing Compute cleanup",
    Effect.fail(
      new Error(
        [
          "Live Prisma Compute cleanup requested but no credentials are configured.",
          "Set PRISMA_SERVICE_TOKEN, set PRISMA_API_TOKEN, or run `alchemy login --configure` and select `Service Token`.",
        ].join(" "),
      ),
    ),
  );
}

test.provider.skipIf(!runCleanup)(
  "live cleans up an existing Prisma Compute project/service from configured credentials",
  () =>
    Effect.gen(function* () {
      const client = yield* Prisma.PrismaClient;
      const projectId = process.env.PRISMA_CLEANUP_PROJECT_ID!.trim();
      const computeServiceId =
        process.env.PRISMA_CLEANUP_COMPUTE_SERVICE_ID?.trim() || undefined;
      const computeVersionId =
        process.env.PRISMA_CLEANUP_COMPUTE_VERSION_ID?.trim() || undefined;

      if (computeVersionId) {
        yield* Prisma.destroyComputeVersion(client, computeVersionId, {
          timeoutSeconds: 240,
        });
      }
      yield* Prisma.destroyComputeProject(client, projectId, {
        timeoutSeconds: 240,
      });

      yield* expectGone("Prisma project", Prisma.getProject(projectId));
      if (computeServiceId) {
        yield* expectGone(
          "Prisma compute service",
          Prisma.getComputeService(computeServiceId),
        );
      }
    }).pipe(logLevel),
  { timeout: 600_000 },
);

test.provider.skipIf(!runLive)(
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
        ["{", '  "type": "module",', '  "main": "server.ts"', "}", ""].join(
          "\n",
        ),
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

      const suffix = yield* Effect.sync(() => Date.now().toString(36));
      const name = `alchemy-compute-${suffix}`;

      yield* stack.destroy();

      let deployed:
        | {
            projectId: string;
            computeServiceId: string;
            computeVersionId: string;
          }
        | undefined;

      yield* Effect.gen(function* () {
        const output = yield* stack.deploy(
          Effect.gen(function* () {
            const project = yield* Prisma.Project("Project", {
              name,
              createDatabase: false,
            });
            const app = yield* Prisma.ComputeApp("App", {
              project: project.projectId,
              serviceName: name,
              path: appDir,
              entrypoint: "server.ts",
              port: 8080,
              env: {
                GREETING: "hello from alchemy",
              },
              timeoutSeconds: 240,
              destroyOldVersion: true,
            });
            return { project, app };
          }),
        );

        expect(output.project.projectId).toBeDefined();
        expect(output.app.computeServiceId).toBeDefined();
        expect(output.app.computeVersionId).toBeDefined();
        expect(output.app.url).toBeDefined();
        deployed = {
          projectId: output.project.projectId,
          computeServiceId: output.app.computeServiceId,
          computeVersionId: output.app.computeVersionId!,
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
                    `computeServiceId=${deployed?.computeServiceId}`,
                    `computeVersionId=${deployed?.computeVersionId}`,
                    deployed
                      ? [
                          "Retry cleanup after the platform fix with:",
                          "PRISMA_SERVICE_TOKEN=... \\",
                          `PRISMA_CLEANUP_PROJECT_ID=${deployed.projectId} \\`,
                          `PRISMA_CLEANUP_COMPUTE_SERVICE_ID=${deployed.computeServiceId} \\`,
                          `PRISMA_CLEANUP_COMPUTE_VERSION_ID=${deployed.computeVersionId} \\`,
                          "bun run --cwd examples/prisma-compute cleanup:live",
                        ].join(" ")
                      : undefined,
                    "Known issue notes: PRISMA_COMPUTE_PLATFORM_BUGS.md",
                  ]
                    .filter((line): line is string => line !== undefined)
                    .join(" "),
                  { cause: error },
                ),
            ),
          );
        yield* expectGone(
          "Prisma project",
          Prisma.getProject(deployed.projectId),
        );
        yield* expectGone(
          "Prisma compute service",
          Prisma.getComputeService(deployed.computeServiceId),
        );
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* stack.destroy().pipe(Effect.ignore);
            yield* fs.remove(appDir, { recursive: true }).pipe(Effect.ignore);
          }),
        ),
      );
    }).pipe(logLevel),
  { timeout: 600_000 },
);

const fetchText = (url: string) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(HttpClientRequest.get(url));
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        new Error(`Prisma Compute app returned HTTP ${response.status}`),
      );
    }
    return yield* response.text;
  }).pipe(
    Effect.retry({
      schedule: Schedule.exponential(Duration.seconds(1)).pipe(
        Schedule.both(Schedule.recurs(8)),
      ),
    }),
  );

const expectGone = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const gone = yield* effect.pipe(
      Effect.as(false),
      Effect.catchIf(Prisma.isNotFound, () => Effect.succeed(true)),
    );
    if (!gone) return yield* Effect.fail(new Error(`${label} still exists`));
  }).pipe(
    Effect.retry({
      schedule: Schedule.exponential(Duration.seconds(1)).pipe(
        Schedule.both(Schedule.recurs(8)),
      ),
    }),
  );
