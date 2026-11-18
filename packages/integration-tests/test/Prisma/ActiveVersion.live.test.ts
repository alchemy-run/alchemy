import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import * as Prisma from "@alchemy.run/prisma";
import { createComputeArchive } from "@alchemy.run/prisma/ComputeArchive";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import {
  createServiceRollback,
  getDeployment,
  getService,
} from "@distilled.cloud/prisma/management";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import { expectGone, expectProjectGone } from "./fixtures/Live.ts";
import { tarArchive } from "./fixtures/TarArchive.ts";

const { test } = Test.make({ providers: Prisma.providers() });

const tags = [
  "live",
  "provider:prisma",
  "provider:prisma:computeservice",
  "provider:prisma:computeversion",
  "provider:prisma:project",
];

/** A Bun HTTP server answering with `text`, archived as a Compute artifact. */
const writeArtifact = (root: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(root, text);
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(
      path.join(directory, "server.ts"),
      [
        'const port = Number(process.env["PORT"] ?? "8080");',
        `Bun.serve({ port, fetch: () => new Response(${JSON.stringify(text)}) });`,
        "export {};",
        "",
      ].join("\n"),
    );
    const bytes = yield* createComputeArchive({ directory, entrypoint: "server.ts" });
    const artifactPath = path.join(root, `${text}.tar.gz`);
    yield* fs.writeFile(artifactPath, bytes);
    return artifactPath;
  });

const app = (artifactPath: string) =>
  Effect.gen(function* () {
    const project = yield* Prisma.Project("Project", { createDatabase: false });
    const service = yield* Prisma.ComputeService("Service", {
      project: project.projectId,
      regionId: "us-east-1",
      urlReadinessTimeoutSeconds: 120,
      timeoutSeconds: 120,
    });
    const version = yield* Prisma.ComputeVersion("Version", {
      service: service.serviceId,
      artifactPath,
      artifactContentType: "application/gzip",
      start: true,
      urlReadinessTimeoutSeconds: 120,
      timeoutSeconds: 240,
    });
    yield* Prisma.activateVersion(service, version);
    return { project, service, version };
  });

/** Poll a URL until it answers `expected`, for at most about two minutes. */
const expectServes = (url: string, expected: string) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(HttpClientRequest.get(url));
    const text = yield* response.text;
    if (response.status !== 200 || text !== expected) {
      return yield* Effect.fail(
        new Error(`${url} answered HTTP ${response.status} '${text.slice(0, 80)}'`),
      );
    }
  }).pipe(Effect.retry({ schedule: Schedule.spaced(Duration.seconds(3)), times: 40 }));

test.provider(
  "keeps the first version after a second one goes live, and the platform rolls back to it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-prisma-active-version-" });
      const v1 = yield* writeArtifact(root, "v1");
      const v2 = yield* writeArtifact(root, "v2");

      const first = yield* stack.deploy(app(v1));
      expect(first.service.activeVersionId).toBe(first.version.versionId);
      yield* expectServes(first.service.url, "v1");

      const second = yield* stack.deploy(app(v2));
      expect(second.service.serviceId).toBe(first.service.serviceId);
      expect(second.version.versionId).not.toBe(first.version.versionId);
      expect(second.service.activeVersionId).toBe(second.version.versionId);
      yield* expectServes(second.service.url, "v2");

      const live = yield* getService({ serviceId: second.service.serviceId });
      expect(live.data.latestDeploymentId).toBe(second.version.versionId);
      const kept = yield* getDeployment({ deploymentId: first.version.versionId });
      expect(kept.data.serviceId).toBe(first.service.serviceId);

      yield* createServiceRollback({
        serviceId: second.service.serviceId,
        deploymentId: first.version.versionId,
      });
      yield* getService({ serviceId: second.service.serviceId }).pipe(
        Effect.flatMap((response) =>
          response.data.latestDeploymentId === first.version.versionId
            ? Effect.void
            : Effect.fail(new Error("the service does not report the first version yet")),
        ),
        Effect.retry({ schedule: Schedule.spaced(Duration.seconds(2)), times: 30 }),
      );
      yield* expectServes(second.service.url, "v1");

      yield* stack.destroy();

      yield* expectGone(
        getService({ serviceId: first.service.serviceId }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      );
      for (const deploymentId of [first.version.versionId, second.version.versionId]) {
        yield* expectGone(
          getDeployment({ deploymentId }).pipe(
            Effect.as(false),
            Effect.catchTag("NotFound", () => Effect.succeed(true)),
          ),
        );
      }
      yield* expectProjectGone(first.project.projectId);
    }).pipe(Effect.scoped),
  { tags, timeout: 240_000 },
);

test.provider(
  "deploys a version from a multi-megabyte archive whose manifest comes first",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // The Prisma CLI writes compute.manifest.json near the start of the
      // archive, and real archives span many reads. A check that stops at the
      // manifest must still end the read and close the file.
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-prisma-big-archive-" });
      const encode = (text: string) => new TextEncoder().encode(text);
      const archive = gzipSync(
        tarArchive([
          {
            name: "compute.manifest.json",
            data: encode('{"manifestVersion":"1","entrypoint":"server.ts"}'),
          },
          {
            name: "server.ts",
            data: encode(
              'Bun.serve({ port: Number(process.env["PORT"] ?? "8080"), fetch: () => new Response("big") });\nexport {};\n',
            ),
          },
          { name: "assets/blob.bin", data: new Uint8Array(randomBytes(3 * 1024 * 1024)) },
        ]),
      );
      const artifactPath = path.join(root, "big.tar.gz");
      yield* fs.writeFile(artifactPath, archive);

      const deployed = yield* stack.deploy(app(artifactPath));
      yield* expectServes(deployed.service.url, "big");

      yield* stack.destroy();
      yield* expectProjectGone(deployed.project.projectId);
    }).pipe(Effect.scoped),
  { tags, timeout: 240_000 },
);
