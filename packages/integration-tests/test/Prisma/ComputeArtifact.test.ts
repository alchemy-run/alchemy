import { createComputeArchive } from "@alchemy.run/prisma/ComputeArchive";
import { ComputeArtifact, ComputeArtifactProvider } from "@alchemy.run/prisma/ComputeArtifact";
import {
  activateVersion,
  ComputeService,
  ComputeServiceProvider,
} from "@alchemy.run/prisma/ComputeService";
import { ComputeVersion, ComputeVersionProvider } from "@alchemy.run/prisma/ComputeVersion";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { type ComputeCloud, makeComputeCloud } from "./fixtures/ComputeCloud.ts";

const tags = [
  "unit",
  "local",
  "provider:prisma",
  "provider:prisma:computeartifact",
  "provider:prisma:computeversion",
  "provider:prisma:computeservice",
];

class ComputeArtifactTestProviders extends Provider.ProviderCollection<ComputeArtifactTestProviders>()(
  "Prisma",
) {}

/** One fake platform per test, so tests that run at the same time never share calls. */
const harness = () => {
  const cloud = makeComputeCloud();
  const providers = Layer.effect(
    ComputeArtifactTestProviders,
    Provider.collection([ComputeArtifact, ComputeService, ComputeVersion]),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(ComputeArtifactProvider(), ComputeServiceProvider(), ComputeVersionProvider()),
    ),
    Layer.provide(
      Layer.succeed(AlchemyContext, { dotAlchemy: ".alchemy-test", dev: false, adopt: false }),
    ),
    Layer.provideMerge(cloud.fake.layer),
  );
  return { cloud, test: Test.make({ providers }).test };
};

const checks = { urlReadinessTimeoutSeconds: 0.2, timeoutSeconds: 2, pollIntervalMs: 1 } as const;

/**
 * An app whose command build copies `src/server.js` to `dist/` and appends a
 * line to `builds.log` beside the app, so a test can count the builds.
 */
const writeApp = (greeting: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-prisma-artifact-" });
    const app = path.join(root, "app");
    yield* fs.makeDirectory(path.join(app, "src"), { recursive: true });
    yield* writeSource(app, greeting);
    return { app, buildsLog: path.join(root, "builds.log") };
  });

const writeSource = (app: string, greeting: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(
      path.join(app, "src", "server.js"),
      `Bun.serve({ port: 8080, fetch: () => new Response(${JSON.stringify(greeting)}) });\n`,
    );
  });

const builds = (buildsLog: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(buildsLog))) return 0;
    return (yield* fs.readFileString(buildsLog)).split("\n").filter((line) => line.length > 0)
      .length;
  });

const program = (app: string) =>
  Effect.gen(function* () {
    const artifact = yield* ComputeArtifact("Artifact", {
      path: app,
      build: {
        command: "mkdir -p dist && cp src/server.js dist/server.js && echo built >> ../builds.log",
        outdir: "dist",
        entrypoint: "server.js",
      },
    });
    const service = yield* ComputeService("Service", {
      project: "project-1",
      branchId: "branch-1",
      ...checks,
    });
    const version = yield* ComputeVersion("Version", {
      service: service.serviceId,
      artifactPath: artifact.artifactPath,
      artifactContentType: "application/gzip",
      ...checks,
    });
    yield* activateVersion(service, version);
    return { artifact, service, version };
  });

const uploads = (cloud: ComputeCloud) =>
  cloud.fake.captured.filter((request) => new URL(request.url).host === "upload.prisma.test")
    .length;

const clearCalls = (cloud: ComputeCloud) =>
  Effect.sync(() => {
    cloud.fake.captured.length = 0;
  });

const archives = harness();
archives.test.provider(
  "archives a directory exactly as Prisma.Compute does",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* stack.destroy();
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-prisma-artifact-" });
      yield* fs.writeFileString(path.join(root, "server.js"), "console.log('hi');\n");
      yield* fs.writeFileString(path.join(root, ".env"), "SECRET=1\n");

      const artifact = yield* stack.deploy(
        ComputeArtifact("Artifact", { path: root, entrypoint: "server.js" }),
      );
      const reference = yield* createComputeArchive({
        directory: root,
        entrypoint: "server.js",
        output: "file",
      });

      expect(artifact.hash).toBe(reference.sha256);
      expect(path.basename(artifact.artifactPath)).toBe(`${reference.sha256}.tar.gz`);
      expect(artifact.defaultPort).toBe(8080);
      yield* reference.cleanup;

      yield* stack.destroy();
      expect(yield* fs.exists(artifact.artifactPath)).toBe(false);
    }).pipe(Effect.scoped),
  { tags },
);

const unchanged = harness();
unchanged.test.provider(
  "skips the build and keeps the version when nothing changed, and replaces it when a source changes",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = unchanged;
      yield* stack.destroy();
      const { app, buildsLog } = yield* writeApp("one");

      const first = yield* stack.deploy(program(app));
      expect(yield* builds(buildsLog)).toBe(1);
      expect(cloud.writes()).toEqual([
        "POST /v1/services",
        "POST /v1/services/svc-1/deployments",
        "POST /v1/deployments/dep-1/start",
        "POST /v1/services/svc-1/promote",
      ]);
      expect(uploads(cloud)).toBe(1);
      expect(first.service.activeVersionId).toBe(first.version.versionId);

      yield* clearCalls(cloud);
      const second = yield* stack.deploy(program(app));
      expect(yield* builds(buildsLog)).toBe(1);
      expect(second.artifact.artifactPath).toBe(first.artifact.artifactPath);
      expect(second.artifact.hash).toBe(first.artifact.hash);
      expect(second.version.versionId).toBe(first.version.versionId);
      expect(cloud.writes()).toEqual(["POST /v1/services/svc-1/promote"]);
      expect(uploads(cloud)).toBe(0);
      expect(cloud.deployments.size).toBe(1);

      yield* writeSource(app, "two");
      yield* clearCalls(cloud);
      const third = yield* stack.deploy(program(app));
      expect(yield* builds(buildsLog)).toBe(2);
      expect(third.artifact.hash).not.toBe(first.artifact.hash);
      expect(third.version.versionId).not.toBe(first.version.versionId);
      expect(cloud.writes()).toEqual([
        "POST /v1/services/svc-1/deployments",
        `POST /v1/deployments/${third.version.versionId}/start`,
        "POST /v1/services/svc-1/promote",
      ]);
      expect(third.service.activeVersionId).toBe(third.version.versionId);

      yield* stack.destroy();
      expect(cloud.services.size).toBe(0);
    }).pipe(Effect.scoped),
  { tags },
);
