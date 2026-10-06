import {
  createServer as createHttpServer,
  type RequestListener,
  type Server as NodeHttpServer,
} from "node:http";
import { BadRequest } from "@distilled.cloud/prisma";
import {
  createDeploymentStop,
  deleteDeployment,
  getServiceDeployments,
} from "@distilled.cloud/prisma/management";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Drift from "@/Drift";
import * as Prisma from "@/Prisma";
import {
  Deployment as PrismaDeployment,
  MAX_DEPLOYMENT_ARTIFACT_BYTES,
  readUploadArtifact,
  validateDeploymentArtifactBytes,
} from "@/Prisma/Deployment";
import { executeArtifactUpload } from "@/Prisma/Internal/ArtifactUpload";
import { PrismaHttpClientLive } from "@/Prisma/Internal/HttpClient";
import { encodeState } from "@/State/StateEncoding";
import * as Test from "@/Test/Alchemy";
import { PlatformServices } from "@/Util/PlatformServices";
import {
  type DeploymentCloudOptions,
  deploymentLayer,
  makeDeploymentCloud,
  SIGNED_URL_SECRET,
  UPLOAD_ERROR_BODY,
  UPLOAD_HOST,
} from "./fixtures/DeploymentFake.ts";
import {
  artifactV1Path,
  artifactV2Path,
  expectAppGone,
  expectDeploymentGone,
  observeApp,
  observeDeployment,
  stateRow,
  tailFromState,
  waitForStatus,
} from "./fixtures/DeploymentLive.ts";
import { routesOf } from "./fixtures/FakeManagementApi.ts";
import { expectProjectGone, failureOf, forgetState, patchStateAttr } from "./fixtures/Live.ts";

// ---------------------------------------------------------------------------
// Pure artifact helpers (no provider involved)
// ---------------------------------------------------------------------------

describe(
  "Prisma Deployment artifact helpers",
  { tags: ["unit", "provider:prisma", "provider:prisma:deployment", "local"] },
  () => {
    it.effect("rejects final artifacts above the upload byte limit", () =>
      Effect.gen(function* () {
        const error = yield* validateDeploymentArtifactBytes(new Uint8Array(9), 8).pipe(
          Effect.flip,
        );

        expect(error.message).toContain("exceeds the 8 byte upload safety limit");
      }),
    );

    it.effect("does not allow callers to raise the upload hard limit", () =>
      Effect.gen(function* () {
        const error = yield* validateDeploymentArtifactBytes(
          new Uint8Array(1),
          MAX_DEPLOYMENT_ARTIFACT_BYTES + 1,
        ).pipe(Effect.flip);

        expect(error.message).toContain("hard limit");
      }),
    );

    it.effect("streams file-backed artifacts with a fixed Content-Length", () => {
      let contentLength: string | undefined;
      let uploadedBytes = 0;

      return withHttpServer(
        (request, response) => {
          contentLength = request.headers["content-length"];
          request.on("data", (chunk: Buffer) => {
            uploadedBytes += chunk.byteLength;
          });
          request.on("end", () => {
            response.statusCode = contentLength === undefined ? 411 : 204;
            response.end();
          });
        },
        (uploadUrl) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectory({
              prefix: "alchemy-prisma-fixed-length-upload-",
            });
            const artifactPath = path.join(root, "artifact.tar.gz");
            yield* fs.writeFileString(artifactPath, "fixed-length-archive");
            const artifact = yield* readUploadArtifact({ artifactPath, output: "file" });

            yield* executeArtifactUpload(uploadUrl, artifact!, "application/gzip");

            expect(contentLength).toBe(String(artifact!.size));
            expect(uploadedBytes).toBe(artifact!.size);
          }).pipe(
            Effect.provide(PrismaHttpClientLive),
            Effect.provide(PlatformServices),
            Effect.scoped,
          ),
      );
    });
  },
);

// ---------------------------------------------------------------------------
// Fault injection: the live provider over an in-memory Management API
// ---------------------------------------------------------------------------

const fakeTags = ["unit", "provider:prisma", "provider:prisma:deployment", "local"];

/** One fake cloud per scenario, so concurrent tests never share fault switches. */
const fakeSuite = (options?: DeploymentCloudOptions) => {
  const cloud = makeDeploymentCloud(options);
  return { cloud, test: Test.make({ providers: deploymentLayer(cloud) }).test };
};

const tempArtifact = (contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectory({ prefix: "alchemy-prisma-deployment-" });
    const artifactPath = path.join(root, "artifact.tar.gz");
    yield* fs.writeFileString(artifactPath, contents);
    return artifactPath;
  }).pipe(Effect.provide(PlatformServices));

const uploadsAndStarts = fakeSuite();

uploadsAndStarts.test.provider(
  "uploads artifactPath bytes, requests the default port, and starts through the canonical routes",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = uploadsAndStarts;
      yield* stack.destroy();
      const artifactPath = yield* tempArtifact("version-archive");
      const declare = PrismaDeployment("Version", {
        app: "service-1",
        artifactPath,
        portMapping: { http: null },
        start: true,
      });
      cloud.fake.captured.length = 0;

      const deployed = yield* stack.deploy(declare);

      expect(deployed.deploymentId).toBe("version-1");
      expect(deployed.status).toBe("running");
      expect(deployed.artifactHash).toBeDefined();
      expect(cloud.createBodies).toEqual([{ portMapping: { http: null } }]);
      expect(cloud.uploads).toHaveLength(1);
      expect(cloud.uploads[0]!.url).toContain(`${UPLOAD_HOST}/version-1.tar.gz`);
      expect(cloud.uploads[0]!.contentType).toBe("application/octet-stream");
      expect(new TextDecoder().decode(cloud.uploads[0]!.bytes)).toBe("version-archive");
      // The cold read before create neither enumerates nor adopts the App's
      // deployments: the first request is the create itself.
      expect(routesOf(cloud.fake.captured)).toEqual([
        "POST /v1/services/service-1/deployments",
        "GET /v1/deployments/version-1",
        "POST /v1/deployments/version-1/start",
        "GET /v1/deployments/version-1",
      ]);

      // Asserted start always reconciles, even with unchanged props.
      const plan = yield* stack.plan(declare);
      expect(plan.resources.Version?.action).toBe("update");

      yield* stack.destroy();
      expect(cloud.deployments.size).toBe(0);
    }),
  { tags: fakeTags },
);

const missingUploadUrl = fakeSuite({ uploadUrl: null });

missingUploadUrl.test.provider(
  "deletes the created deployment when Prisma omits an upload URL",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = missingUploadUrl;
      yield* stack.destroy();

      const failed = yield* failureOf(
        stack.deploy(
          PrismaDeployment("Version", { app: "service-1", artifactPath: artifactV1Path }),
        ),
      );

      expect(failed.text).toContain("did not return an upload URL");
      expect(routesOf(cloud.fake.captured)).toContain("DELETE /v1/deployments/version-1");
      expect(cloud.deployments.size).toBe(0);

      yield* stack.destroy();
    }),
  { tags: fakeTags },
);

const uploadRejected = fakeSuite({ upload: "status500" });

uploadRejected.test.provider(
  "deletes the created deployment when the artifact upload fails, without echoing the upload body",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = uploadRejected;
      yield* stack.destroy();

      const failed = yield* failureOf(
        stack.deploy(
          PrismaDeployment("Version", { app: "service-1", artifactPath: artifactV1Path }),
        ),
      );

      expect(failed.text).toContain("artifact upload failed");
      expect(failed.text).toContain("HTTP 500");
      expect(failed.text).toContain(`${UPLOAD_ERROR_BODY.length} bytes`);
      expect(failed.text).not.toContain(UPLOAD_ERROR_BODY);
      expect(failed.text).not.toContain(SIGNED_URL_SECRET);
      expect(routesOf(cloud.fake.captured)).toContain("DELETE /v1/deployments/version-1");
      expect(cloud.deployments.size).toBe(0);

      yield* stack.destroy();
    }),
  { tags: fakeTags },
);

const uploadTransportFailure = fakeSuite({ upload: "transportError" });

uploadTransportFailure.test.provider(
  "redacts the signed upload URL from transport failures",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = uploadTransportFailure;
      yield* stack.destroy();

      const failed = yield* failureOf(
        stack.deploy(
          PrismaDeployment("Version", { app: "service-1", artifactPath: artifactV1Path }),
        ),
      );

      expect(failed.text).toContain("transport failed");
      expect(failed.text).not.toContain(SIGNED_URL_SECRET);
      expect(failed.text).not.toContain(UPLOAD_HOST);
      expect(JSON.stringify(failed.errors)).not.toContain(SIGNED_URL_SECRET);
      expect(routesOf(cloud.fake.captured)).toContain("DELETE /v1/deployments/version-1");

      yield* stack.destroy();
    }),
  { tags: fakeTags },
);

const changedArtifact = fakeSuite({ upload: "mutateFile" });

changedArtifact.test.provider(
  "refuses to upload an artifact file that changed after validation",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = changedArtifact;
      yield* stack.destroy();
      const artifactPath = yield* tempArtifact("first!!");
      cloud.knobs.mutatePath = artifactPath;

      const failed = yield* failureOf(
        stack.deploy(PrismaDeployment("Version", { app: "service-1", artifactPath })),
      );

      expect(failed.text).toContain("transport failed");
      expect(failed.text).not.toContain(SIGNED_URL_SECRET);
      expect(cloud.uploadFailures.join("\n")).toContain("changed after it was validated");
      expect(cloud.uploads).toHaveLength(0);
      expect(routesOf(cloud.fake.captured)).toContain("DELETE /v1/deployments/version-1");

      yield* stack.destroy();
    }),
  { tags: fakeTags },
);

const startFails = fakeSuite({ startFails: true });

startFails.test.provider(
  "deletes the created deployment when start fails",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = startFails;
      yield* stack.destroy();

      const failed = yield* failureOf(
        stack.deploy(
          PrismaDeployment("Version", { app: "service-1", skipCodeUpload: true, start: true }),
        ),
      );

      expect(
        failed.errors.some(
          (error) => error instanceof BadRequest && error.message === "start failed",
        ),
      ).toBe(true);
      expect(routesOf(cloud.fake.captured)).toContain("DELETE /v1/deployments/version-1");
      expect(cloud.deployments.size).toBe(0);

      yield* stack.destroy();
    }),
  { tags: fakeTags },
);

const startAndCleanupFail = fakeSuite({ startFails: true, deleteFails: true });

startAndCleanupFail.test.provider(
  "preserves both the start failure and the cleanup failure for an orphaned deployment",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = startAndCleanupFail;
      yield* stack.destroy();

      const failed = yield* failureOf(
        stack.deploy(
          PrismaDeployment("Version", { app: "service-1", skipCodeUpload: true, start: true }),
        ),
      );

      const aggregate = failed.errors.find((error) => error instanceof AggregateError);
      expect(aggregate).toBeInstanceOf(AggregateError);
      if (aggregate instanceof AggregateError) {
        expect(aggregate.message).toContain("version-1");
        expect(aggregate.message).toContain("DELETE /v1/deployments/version-1");
        expect(aggregate.errors).toHaveLength(2);
        expect(String(aggregate.errors[0])).toContain("start failed");
        expect(String(aggregate.errors[1])).toContain("cleanup failed");
      }
      expect(cloud.deployments.has("version-1")).toBe(true);

      cloud.knobs.deleteFails = false;
      yield* stack.destroy();
    }),
  { tags: fakeTags },
);

const ambiguousPromotion = fakeSuite({ promotionFails: true });

ambiguousPromotion.test.provider(
  "preserves the deployment when the promotion commit state is ambiguous",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = ambiguousPromotion;
      yield* stack.destroy();

      const failed = yield* failureOf(
        stack.deploy(
          PrismaDeployment("Version", { app: "service-1", skipCodeUpload: true, promote: true }),
        ),
      );

      const aggregate = failed.errors.find((error) => error instanceof AggregateError);
      expect(aggregate).toBeInstanceOf(AggregateError);
      expect(String(aggregate)).toContain("commit state");
      const routes = routesOf(cloud.fake.captured);
      expect(routes).toContain("POST /v1/services/service-1/promote");
      expect(routes).toContain("POST /v1/services/service-1/rollback");
      expect(routes).not.toContain("DELETE /v1/deployments/version-1");
      expect(cloud.deployments.has("version-1")).toBe(true);

      yield* stack.destroy();
    }),
  { tags: fakeTags },
);

const recovery = fakeSuite();

recovery.test.provider(
  "refresh recovers a deployment by its Foundry version ID and refuses an ambiguous match",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = recovery;
      yield* stack.destroy();
      const identity = { name: stack.name, stage: stack.stage };
      const detect = Drift.detect(identity).pipe(Effect.provide(stack.state));

      yield* stack.deploy(PrismaDeployment("Version", { app: "service-1", skipCodeUpload: true }));

      // A saved deployment is read through its own route and proven to be
      // a member of the App.
      cloud.fake.captured.length = 0;
      const unchanged = yield* detect;
      expect(unchanged.resources.Version).toMatchObject({
        attr: { deploymentId: "version-1", appId: "service-1" },
      });
      expect(unchanged.resources.Version?.action).not.toBe("missing");
      expect(routesOf(cloud.fake.captured)).toEqual([
        "GET /v1/deployments/version-1",
        "GET /v1/services/service-1/deployments",
      ]);

      // The saved deployment ID is gone, but its Foundry version survives
      // under a new deployment ID.
      const original = cloud.deployments.get("version-1")!;
      cloud.deployments.delete("version-1");
      cloud.deployments.set("version-9", { ...original, id: "version-9" });
      cloud.fake.captured.length = 0;
      const recovered = yield* detect;
      expect(recovered.resources.Version).toMatchObject({
        action: "drifted",
        attr: { deploymentId: "version-9", appId: "service-1" },
      });
      expect(cloud.fake.captured.map((request) => `${request.pathname}${request.search}`)).toEqual([
        "/v1/deployments/version-1",
        "/v1/services/service-1/deployments?limit=100",
        "/v1/deployments/version-9",
      ]);

      // Two deployments sharing the Foundry version cannot be told apart.
      cloud.deployments.set("version-10", { ...original, id: "version-10" });
      const ambiguous = yield* failureOf(detect);
      expect(ambiguous.text).toContain("ambiguous recovery match");

      cloud.deployments.clear();
      yield* stack.destroy();
    }),
  { tags: fakeTags },
);

const outputApp = fakeSuite();

outputApp.test.provider(
  "refresh reads a saved deployment through the App ID recorded in its attributes",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = outputApp;
      yield* stack.destroy();

      yield* stack.deploy(PrismaDeployment("Version", { app: "service-1", skipCodeUpload: true }));
      // The recorded App ID, not the declared one, owns the deployment.
      cloud.deployments.get("version-1")!.serviceId = "service-2";
      yield* patchStateAttr(stack, "Version", { appId: "service-2" });

      cloud.fake.captured.length = 0;
      const detected = yield* Drift.detect({ name: stack.name, stage: stack.stage }).pipe(
        Effect.provide(stack.state),
      );
      expect(detected.resources.Version).toMatchObject({
        attr: { deploymentId: "version-1", appId: "service-2" },
      });
      const routes = routesOf(cloud.fake.captured);
      expect(routes).toContain("GET /v1/services/service-2/deployments");
      expect(routes).not.toContain("GET /v1/services/service-1/deployments");

      yield* stack.destroy();
      expect(cloud.deployments.size).toBe(0);
    }),
  { tags: fakeTags },
);

const failedGeneration = fakeSuite();

failedGeneration.test.provider(
  "replaces a terminal failed deployment and promotes the replacement before deleting it",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = failedGeneration;
      yield* stack.destroy();
      const declare = PrismaDeployment("Version", {
        app: "service-1",
        skipCodeUpload: true,
        promote: true,
      });

      const first = yield* stack.deploy(declare);
      expect(first.deploymentId).toBe("version-1");
      // Foundry's failed status is terminal; the refreshed attributes say so.
      cloud.deployments.get("version-1")!.status = "failed";
      yield* patchStateAttr(stack, "Version", { status: "failed" });

      const plan = yield* stack.plan(declare);
      expect(plan.resources.Version?.action).toBe("replace");

      cloud.fake.captured.length = 0;
      const replaced = yield* stack.deploy(declare);
      expect(replaced.deploymentId).toBe("version-2");
      expect(replaced.status).toBe("running");

      const routes = routesOf(cloud.fake.captured);
      const createIndex = routes.indexOf("POST /v1/services/service-1/deployments");
      const promoteIndex = routes.indexOf("POST /v1/services/service-1/promote");
      const deleteIndex = routes.indexOf("DELETE /v1/deployments/version-1");
      expect(createIndex).toBeGreaterThanOrEqual(0);
      expect(createIndex).toBeLessThan(promoteIndex);
      expect(promoteIndex).toBeLessThan(deleteIndex);
      expect(routes).not.toContain("POST /v1/deployments/version-1/start");
      expect(cloud.deployments.has("version-1")).toBe(false);
      expect(cloud.appOf("service-1").latestDeploymentId).toBe("version-2");

      yield* stack.destroy();
      expect(cloud.deployments.size).toBe(0);
    }),
  { tags: fakeTags },
);

const stillStopping = fakeSuite();

stillStopping.test.provider(
  "reports a deployment that is still stopping as a delete in progress",
  (stack) =>
    Effect.gen(function* () {
      const { cloud } = stillStopping;
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        PrismaDeployment("Version", { app: "service-1", skipCodeUpload: true, start: true }),
      );
      expect(deployed.status).toBe("running");

      // The stop wait reads the wall clock, so jump it on every poll that
      // still observes `stopping` instead of sleeping two minutes.
      cloud.knobs.stickyStop = true;
      const realNow = Date.now;
      let skippedMs = 0;
      cloud.onGetDeployment.push((deployment) => {
        if (deployment.status === "stopping") skippedMs += 61_000;
      });
      cloud.fake.captured.length = 0;
      const failed = yield* Effect.sync(() => {
        Date.now = () => realNow() + skippedMs;
      }).pipe(
        Effect.andThen(failureOf(stack.destroy())),
        Effect.ensuring(
          Effect.sync(() => {
            Date.now = realNow;
          }),
        ),
      );

      expect(failed.text).toContain("last status: 'stopping'");
      expect(failed.text).toContain("only a stopped deployment can be deleted");
      const routes = routesOf(cloud.fake.captured);
      expect(routes).toContain("POST /v1/deployments/version-1/stop");
      expect(routes).not.toContain("DELETE /v1/deployments/version-1");
      expect(cloud.deployments.get("version-1")?.status).toBe("stopping");

      // Once the stop drains, the retried delete completes.
      cloud.knobs.stickyStop = false;
      cloud.deployments.get("version-1")!.status = "stopped";
      yield* stack.destroy();
      expect(cloud.deployments.size).toBe(0);
    }),
  // Patches the process-wide `Date.now`.
  { tags: fakeTags, exclusive: true },
);

// ---------------------------------------------------------------------------
// Live: the real Prisma Management API
// ---------------------------------------------------------------------------

const live = Test.make({ providers: Prisma.providers() });

const liveTags = [
  "provider:prisma",
  "provider:prisma:deployment",
  "provider:prisma:app",
  "provider:prisma:project",
  "live",
];

const fetchText = (url: string) =>
  Effect.gen(function* () {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const response = yield* client.get(url);
    return yield* response.text;
  }).pipe(
    Effect.retry({ schedule: Schedule.spaced("4 seconds"), times: 10 }),
    Effect.provide(FetchHttpClient.layer),
  );

live.test.provider(
  "uploads an artifact, starts and promotes it, and replays start and promotion after an out-of-band stop",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const resources = Effect.gen(function* () {
      const project = yield* Prisma.Project("Project", { createDatabase: false });
      const app = yield* Prisma.App("Web", { project });
      const deployment = yield* Prisma.Deployment("Deployment", {
        app,
        artifactPath: artifactV1Path,
        promote: true,
      });
      return { project, app, deployment };
    });

    const initial = yield* stack.deploy(resources);
    const deploymentId = initial.deployment.deploymentId;
    expect(initial.deployment.appId).toBe(initial.app.appId);
    expect(initial.deployment.status).toBe("running");
    expect(initial.deployment.artifactHash).toBeDefined();
    expect(initial.deployment.appEndpointDomain).toBeDefined();
    const observed = yield* observeDeployment(deploymentId);
    expect(observed.status).toBe("running");
    expect(observed.serviceId).toBe(initial.app.appId);
    expect((yield* observeApp(initial.app.appId)).latestDeploymentId).toBe(deploymentId);

    // Logs stream through the provider's tail, the way `alchemy logs --tail`
    // reaches it; the request below makes the uploaded server log a line.
    const tail = yield* tailFromState(stack, "Deployment").pipe(
      Stream.filter((line) => line.message.includes("alchemy deployment fixture v1")),
      Stream.take(1),
      Stream.runCollect,
      Effect.timeout("90 seconds"),
      Effect.forkChild({ startImmediately: true }),
    );
    // The App's stable endpoint serves the uploaded artifact.
    expect(yield* fetchText(Prisma.toDeploymentUrl(initial.deployment.appEndpointDomain)!)).toBe(
      "v1",
    );
    const lines = yield* Fiber.join(tail);
    expect(lines.length).toBe(1);

    // Stop the deployment out of band. Refresh observes it.
    yield* createDeploymentStop({ deploymentId });
    expect((yield* waitForStatus(deploymentId, "stopped")).status).toBe("stopped");
    const detected = yield* Drift.detect({ name: stack.name, stage: stack.stage }).pipe(
      Effect.provide(stack.state),
    );
    expect(detected.resources.Deployment).toMatchObject({
      action: "drifted",
      attr: { deploymentId, status: "stopped" },
    });

    // Asserted promotion always reconciles, even with unchanged props.
    const plan = yield* stack.plan(resources);
    expect(plan.resources.Deployment?.action).toBe("update");

    const repaired = yield* stack.deploy(resources);
    expect(repaired.deployment.deploymentId).toBe(deploymentId);
    expect(repaired.deployment.status).toBe("running");
    expect((yield* observeDeployment(deploymentId)).status).toBe("running");
    expect((yield* observeApp(initial.app.appId)).latestDeploymentId).toBe(deploymentId);

    yield* stack.destroy();
    yield* expectDeploymentGone(deploymentId);
    yield* expectAppGone(initial.app.appId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 240_000 },
);

live.test.provider(
  "replaces the deployment when its artifact bytes or App change and keeps it when nothing changed",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectory({ prefix: "alchemy-prisma-deployment-artifact-" });
    const artifactPath = path.join(root, "app.tar.gz");
    yield* fs.copyFile(artifactV1Path, artifactPath);

    const resources = (options: { target?: "web" | "admin"; webProject?: "main" | "other" }) =>
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const other = yield* Prisma.Project("Other", { createDatabase: false });
        const web = yield* Prisma.App("Web", {
          project: options.webProject === "other" ? other : project,
        });
        const admin = yield* Prisma.App("Admin", { project });
        const deployment = yield* Prisma.Deployment("Deployment", {
          app: options.target === "admin" ? admin : web,
          artifactPath,
        });
        return { project, other, web, admin, deployment };
      });

    const initial = yield* stack.deploy(resources({}));
    expect(initial.deployment.appId).toBe(initial.web.appId);
    expect(initial.deployment.artifactHash).toBeDefined();

    // Same bytes, same App: nothing to do.
    const unchanged = yield* stack.plan(resources({}));
    expect(unchanged.resources.Deployment?.action).toBe("noop");

    // A different App is a different deployment.
    const moved = yield* stack.plan(resources({ target: "admin" }));
    expect(moved.resources.Deployment?.action).toBe("replace");

    yield* fs.copyFile(artifactV2Path, artifactPath);
    // New bytes replace the deployment even while its App is being
    // replaced and so has no ID yet at plan time.
    const unresolvedApp = yield* stack.plan(resources({ webProject: "other" }));
    expect(unresolvedApp.resources.Web?.action).toBe("replace");
    expect(unresolvedApp.resources.Deployment?.action).toBe("replace");

    const replaced = yield* stack.deploy(resources({}));
    expect(replaced.deployment.deploymentId).not.toBe(initial.deployment.deploymentId);
    expect(replaced.deployment.artifactHash).not.toBe(initial.deployment.artifactHash);
    yield* expectDeploymentGone(initial.deployment.deploymentId);
    expect((yield* observeDeployment(replaced.deployment.deploymentId)).serviceId).toBe(
      initial.web.appId,
    );

    yield* stack.destroy();
    yield* expectDeploymentGone(replaced.deployment.deploymentId);
    yield* expectAppGone(initial.web.appId);
    yield* expectAppGone(initial.admin.appId);
    yield* expectProjectGone(initial.project.projectId);
    yield* expectProjectGone(initial.other.projectId);
  }),
  { tags: liveTags, timeout: 240_000 },
);

live.test.provider(
  "replaces on changed triggers, keeps their fingerprint redacted, and tolerates a missing fingerprint",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();
    const secret = "REDEPLOY_SECRET_SENTINEL";

    const resources = (options: { secret?: string; flag?: string; appName?: string } = {}) =>
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const app = yield* Prisma.App("Web", {
          project,
          ...(options.appName === undefined ? {} : { displayName: options.appName }),
        });
        const redacted = yield* Prisma.Deployment("Redacted", {
          app,
          artifactPath: artifactV1Path,
          triggers: { DATABASE_URL: Redacted.make(options.secret ?? secret) },
        });
        const plain = yield* Prisma.Deployment("Plain", {
          app,
          artifactPath: artifactV1Path,
          triggers: { FEATURE_FLAG: options.flag ?? "off" },
        });
        // Reads an App attribute that an App rename leaves unknown at plan time.
        const named = yield* Prisma.Deployment("Named", {
          app,
          artifactPath: artifactV1Path,
          triggers: { APP_NAME: app.name },
        });
        return { project, app, redacted, plain, named };
      });

    const initial = yield* stack.deploy(resources());
    const fingerprint = initial.redacted.triggersHash;
    expect(Redacted.isRedacted(fingerprint)).toBe(true);
    expect(Redacted.value(fingerprint!)).not.toContain(secret);
    // encodeState is what a state store writes for the attributes.
    const row = yield* stateRow(stack, "Redacted");
    expect(JSON.stringify(encodeState(row.attr))).not.toContain(secret);

    const unchanged = yield* stack.plan(resources());
    expect(unchanged.resources.Redacted?.action).toBe("noop");
    expect(unchanged.resources.Plain?.action).toBe("noop");
    expect(unchanged.resources.Named?.action).toBe("noop");

    const rotated = yield* stack.plan(resources({ secret: `${secret}-rotated` }));
    expect(rotated.resources.Redacted?.action).toBe("replace");
    expect(rotated.resources.Plain?.action).toBe("noop");

    const flagged = yield* stack.plan(resources({ flag: "on" }));
    expect(flagged.resources.Plain?.action).toBe("replace");

    // An unresolved trigger with a recorded fingerprint replaces conservatively.
    const renamed = yield* stack.plan(resources({ appName: "renamed-web" }));
    expect(renamed.resources.Web?.action).toBe("update");
    expect(renamed.resources.Named?.action).toBe("replace");

    // A deployment recorded before triggers existed has no fingerprint:
    // nothing to compare against, so neither a resolved nor an unresolved
    // trigger replaces it.
    yield* patchStateAttr(stack, "Plain", { triggersHash: undefined });
    yield* patchStateAttr(stack, "Named", { triggersHash: undefined });
    const unrecorded = yield* stack.plan(resources());
    expect(unrecorded.resources.Plain?.action).toBe("noop");
    const unrecordedRenamed = yield* stack.plan(resources({ appName: "renamed-web" }));
    expect(unrecordedRenamed.resources.Named?.action).toBe("update");

    const redeployed = yield* stack.deploy(resources({ secret: `${secret}-rotated` }));
    expect(redeployed.redacted.deploymentId).not.toBe(initial.redacted.deploymentId);
    expect(redeployed.plain.deploymentId).toBe(initial.plain.deploymentId);
    expect(redeployed.named.deploymentId).toBe(initial.named.deploymentId);
    yield* expectDeploymentGone(initial.redacted.deploymentId);

    yield* stack.destroy();
    yield* expectDeploymentGone(redeployed.redacted.deploymentId);
    yield* expectDeploymentGone(initial.plain.deploymentId);
    yield* expectDeploymentGone(initial.named.deploymentId);
    yield* expectAppGone(initial.app.appId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 240_000 },
);

live.test.provider(
  "rejects invalid ports, start/promotion flags, missing sources, symbolic links, and oversized artifacts, and accepts the null port",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectory({ prefix: "alchemy-prisma-deployment-invalid-" });
    const symlinkPath = path.join(root, "artifact-link.tar.gz");
    yield* fs.symlink(artifactV1Path, symlinkPath);
    // Sparse, so the over-limit file costs no disk.
    const oversizedPath = path.join(root, "oversized.tar.gz");
    yield* fs.writeFileString(oversizedPath, "");
    yield* fs.truncate(oversizedPath, MAX_DEPLOYMENT_ARTIFACT_BYTES + 1);

    const resources = (id: string, props?: Omit<Prisma.DeploymentProps, "app">) =>
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const app = yield* Prisma.App("Web", { project });
        const deployment =
          props === undefined ? undefined : yield* Prisma.Deployment(id, { app, ...props });
        return { project, app, deployment };
      });

    const base = yield* stack.deploy(resources("None"));

    const invalid: Array<[string, Omit<Prisma.DeploymentProps, "app">, string]> = [
      [
        "PortZero",
        { artifactPath: artifactV1Path, portMapping: { http: 0 } },
        "portMapping.http must be an integer between 1 and 65535",
      ],
      [
        "PortTooLarge",
        { artifactPath: artifactV1Path, portMapping: { http: 65_536 } },
        "portMapping.http must be an integer between 1 and 65535",
      ],
      [
        "PortFractional",
        { artifactPath: artifactV1Path, portMapping: { http: 1.5 } },
        "portMapping.http must be an integer between 1 and 65535",
      ],
      [
        "PromoteWithoutStart",
        { skipCodeUpload: true, start: false, promote: true },
        "promote cannot be combined with start: false",
      ],
      ["NoSource", {}, "requires artifactPath or skipCodeUpload: true"],
      ["Symlink", { artifactPath: symlinkPath }, "symbolic link"],
      [
        "Oversized",
        { artifactPath: oversizedPath },
        `exceeds the ${MAX_DEPLOYMENT_ARTIFACT_BYTES} byte upload safety limit`,
      ],
    ];
    for (const [id, props, message] of invalid) {
      const failed = yield* failureOf(stack.deploy(resources(id, props)));
      expect(failed.text).toContain(message);
    }
    // Every rejection happened before Prisma was asked to create anything.
    const listed = yield* getServiceDeployments({ serviceId: base.app.appId });
    expect(listed.data).toHaveLength(0);

    // `null` asks Foundry for its default port.
    const nullPort = yield* stack.deploy(
      resources("NullPort", { artifactPath: artifactV1Path, portMapping: { http: null } }),
    );
    const observed = yield* observeDeployment(nullPort.deployment!.deploymentId);
    expect(observed.serviceId).toBe(base.app.appId);
    if (observed.portMapping?.http !== undefined) {
      expect(observed.portMapping.http).toBe(8080);
    }

    yield* stack.destroy();
    yield* expectDeploymentGone(nullPort.deployment!.deploymentId);
    yield* expectAppGone(base.app.appId);
    yield* expectProjectGone(base.project.projectId);
  }),
  { tags: liveTags, timeout: 240_000 },
);

live.test.provider(
  "after lost state, creates a new deployment instead of adopting the App's latest one",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const resources = Effect.gen(function* () {
      const project = yield* Prisma.Project("Project", { createDatabase: false });
      const app = yield* Prisma.App("Web", { project });
      const deployment = yield* Prisma.Deployment("Deployment", {
        app,
        artifactPath: artifactV1Path,
      });
      return { project, app, deployment };
    });

    const initial = yield* stack.deploy(resources);
    yield* forgetState(stack, "Deployment");

    // Prisma has no idempotency key for deployments, so nothing proves the
    // existing one is ours.
    const recreated = yield* stack.deploy(resources);
    expect(recreated.deployment.deploymentId).not.toBe(initial.deployment.deploymentId);
    const listed = yield* getServiceDeployments({ serviceId: initial.app.appId });
    expect(listed.data.map((deployment) => deployment.id).sort()).toEqual(
      [initial.deployment.deploymentId, recreated.deployment.deploymentId].sort(),
    );

    // Destroying the App cascades the untracked deployment.
    yield* stack.destroy();
    yield* expectDeploymentGone(recreated.deployment.deploymentId);
    yield* expectDeploymentGone(initial.deployment.deploymentId);
    yield* expectAppGone(initial.app.appId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 180_000 },
);

live.test.provider(
  "refresh reports a deployment deleted out of band as missing and recreates it",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const app = yield* Prisma.App("Web", { project });
        const deployment = yield* Prisma.Deployment("Deployment", {
          app,
          artifactPath: artifactV1Path,
        });
        return { project, app, deployment };
      }),
    );
    yield* deleteDeployment({ deploymentId: initial.deployment.deploymentId });
    yield* expectDeploymentGone(initial.deployment.deploymentId);

    const identity = { name: stack.name, stage: stack.stage };
    const detected = yield* Drift.detect(identity).pipe(Effect.provide(stack.state));
    expect(detected.resources.Deployment?.action).toBe("missing");

    const repaired = yield* Drift.repair(identity).pipe(Effect.provide(stack.state));
    expect(repaired.resources.Deployment?.action).toBe("recreated");
    const recreatedId: string = repaired.resources.Deployment?.attr.deploymentId;
    expect(recreatedId).not.toBe(initial.deployment.deploymentId);
    const observed = yield* observeDeployment(recreatedId);
    expect(observed.serviceId).toBe(initial.app.appId);

    yield* stack.destroy();
    yield* expectDeploymentGone(recreatedId);
    yield* expectAppGone(initial.app.appId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 180_000 },
);

// ---------------------------------------------------------------------------

const withHttpServer = <A, E, R>(
  handler: RequestListener,
  f: (url: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => createHttpServer(handler)),
    (server) => Effect.flatMap(listenHttpServerUrl(server), f),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }).pipe(Effect.ignore),
  );

const listenHttpServerUrl = (server: NodeHttpServer) =>
  Effect.callback<string, Error>((resume) => {
    const complete = () => {
      cleanup();
      const address = server.address();
      if (address && typeof address === "object") {
        resume(Effect.succeed(`http://127.0.0.1:${address.port}`));
      } else {
        resume(Effect.fail(new Error("HTTP server has no TCP address")));
      }
    };
    const fail = (cause: unknown) => {
      cleanup();
      resume(Effect.fail(cause instanceof Error ? cause : new Error(String(cause))));
    };
    const cleanup = () => {
      server.off("listening", complete);
      server.off("error", fail);
    };

    server.once("listening", complete);
    server.once("error", fail);
    server.listen(0, "127.0.0.1");
    return Effect.sync(cleanup);
  });
