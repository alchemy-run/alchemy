import * as Prisma from "@alchemy.run/prisma";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import {
  getDeployment,
  getService,
  getServiceDeployments,
} from "@distilled.cloud/prisma/management";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import { expectGone, expectProjectGone } from "./fixtures/Live.ts";

const { test } = Test.make({ providers: Prisma.providers() });

const tags = [
  "live",
  "provider:prisma",
  "provider:prisma:computeartifact",
  "provider:prisma:computeservice",
  "provider:prisma:computeversion",
  "provider:prisma:project",
];

const app = (directory: string) =>
  Effect.gen(function* () {
    const project = yield* Prisma.Project("Project", { createDatabase: false });
    const artifact = yield* Prisma.ComputeArtifact("Artifact", {
      path: directory,
      entrypoint: "server.ts",
    });
    const service = yield* Prisma.ComputeService("Service", {
      project: project.projectId,
      regionId: "us-east-1",
      urlReadinessTimeoutSeconds: 120,
      timeoutSeconds: 120,
    });
    const version = yield* Prisma.ComputeVersion("Version", {
      service: service.serviceId,
      artifactPath: artifact.artifactPath,
      artifactContentType: "application/gzip",
      portMapping: { http: artifact.defaultPort },
      urlReadinessTimeoutSeconds: 120,
      timeoutSeconds: 240,
    });
    yield* Prisma.activateVersion(service, version);
    return { project, artifact, service, version };
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

const deploymentIds = (serviceId: string) =>
  getServiceDeployments({ serviceId }).pipe(
    Effect.map((response) => response.data.map((deployment) => deployment.id).sort()),
  );

test.provider(
  "serves a version built by ComputeArtifact, and an unchanged redeploy creates no new version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-prisma-compute-artifact-",
      });
      yield* fs.writeFileString(
        path.join(directory, "server.ts"),
        [
          'const port = Number(process.env["PORT"] ?? "8080");',
          'Bun.serve({ port, fetch: () => new Response("from-artifact") });',
          "export {};",
          "",
        ].join("\n"),
      );

      const first = yield* stack.deploy(app(directory));
      expect(first.service.activeVersionId).toBe(first.version.versionId);
      yield* expectServes(first.service.url, "from-artifact");
      const before = yield* deploymentIds(first.service.serviceId);
      expect(before).toEqual([first.version.versionId]);

      const second = yield* stack.deploy(app(directory));
      expect(second.artifact.hash).toBe(first.artifact.hash);
      expect(second.artifact.artifactPath).toBe(first.artifact.artifactPath);
      expect(second.version.versionId).toBe(first.version.versionId);
      expect(yield* deploymentIds(first.service.serviceId)).toEqual(before);
      yield* expectServes(second.service.url, "from-artifact");

      yield* stack.destroy();

      yield* expectGone(
        getService({ serviceId: first.service.serviceId }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      );
      yield* expectGone(
        getDeployment({ deploymentId: first.version.versionId }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      );
      yield* expectProjectGone(first.project.projectId);
      expect(yield* fs.exists(first.artifact.artifactPath)).toBe(false);
    }).pipe(Effect.scoped),
  { tags, timeout: 900_000 },
);
