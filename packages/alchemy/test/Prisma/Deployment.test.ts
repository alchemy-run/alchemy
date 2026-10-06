import {
  createServer as createHttpServer,
  type RequestListener,
  type Server as NodeHttpServer,
} from "node:http";
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
import { readArtifactFile } from "@/Prisma/Internal/ArtifactFile";
import { executeArtifactUpload } from "@/Prisma/Internal/ArtifactUpload";
import { PrismaHttpClientLive } from "@/Prisma/Internal/HttpClient";
import { encodeState } from "@/State/StateEncoding";
import * as Test from "@/Test/Alchemy";
import { PlatformServices } from "@/Util/PlatformServices";
import {
  artifactV1Path,
  artifactV2Path,
  controlArtifactPath,
  expectAppGone,
  expectDeploymentGone,
  observeApp,
  observeDeployment,
  patchStateProps,
  stateRow,
  tailFromState,
  waitForStatus,
} from "./fixtures/DeploymentLive.ts";
import { expectProjectGone, failureOf, forgetState, patchStateAttr } from "./fixtures/Live.ts";

const SIGNED_URL_SECRET = "SIGNED_QUERY_SECRET_SENTINEL";
const UPLOAD_ERROR_BODY = "SIGNED_UPLOAD_SECRET_SENTINEL";

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

    it.effect("refuses to read an artifact file that changed after validation", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-prisma-changed-" });
        const artifactPath = path.join(root, "artifact.tar.gz");
        yield* fs.writeFileString(artifactPath, "first!!");
        const artifact = yield* readUploadArtifact({ artifactPath, output: "file" });

        yield* fs.writeFileString(artifactPath, "second!");
        const error = yield* readArtifactFile(artifact!).pipe(Effect.flip);

        expect(error.message).toContain("changed after it was validated");
      }).pipe(Effect.provide(PlatformServices), Effect.scoped),
    );

    it.effect(
      "reports a rejected upload by status and body size without echoing the body or signed URL",
      () =>
        withHttpServer(
          (request, response) => {
            request.resume();
            request.on("end", () => {
              response.statusCode = 500;
              response.end(UPLOAD_ERROR_BODY);
            });
          },
          (url) =>
            executeArtifactUpload(
              `${url}/artifact.tar.gz?signature=${SIGNED_URL_SECRET}`,
              new TextEncoder().encode("archive"),
              "application/octet-stream",
            ).pipe(
              Effect.flip,
              Effect.map((error) => {
                expect(error.message).toContain("artifact upload failed");
                expect(error.message).toContain("HTTP 500");
                expect(error.message).toContain(`${UPLOAD_ERROR_BODY.length} bytes`);
                expect(error.message).not.toContain(UPLOAD_ERROR_BODY);
                expect(error.message).not.toContain(SIGNED_URL_SECRET);
              }),
              Effect.provide(PrismaHttpClientLive),
            ),
        ),
    );

    it.effect("redacts the signed upload URL from transport failures", () =>
      Effect.gen(function* () {
        // The server is closed again before the upload, so the connection is refused.
        const url = yield* withHttpServer(
          (_request, response) => response.end(),
          (url) => Effect.succeed(url),
        );
        const error = yield* executeArtifactUpload(
          `${url}/artifact.tar.gz?signature=${SIGNED_URL_SECRET}`,
          new TextEncoder().encode("archive"),
          "application/octet-stream",
        ).pipe(Effect.flip, Effect.provide(PrismaHttpClientLive));

        expect(error.message).toContain("transport failed");
        expect(error.message).not.toContain(SIGNED_URL_SECRET);
        expect(error.message).not.toContain(url);
      }),
    );
  },
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
  "rejects invalid ports, start/promotion flags, missing sources, forks without a live deployment, symbolic links, and oversized artifacts, and accepts the null port",
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
      // Prisma itself rejects the create: there is no promoted artifact to reuse.
      ["ForkWithoutLiveDeployment", { skipCodeUpload: true, start: true }, "no live deployment"],
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
    // No rejection left a deployment behind.
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

live.test.provider(
  "starts on Foundry's default port, re-asserts start on every deploy, and reports a still-stopping deployment as a delete in progress",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();

    const resources = Effect.gen(function* () {
      const project = yield* Prisma.Project("Project", { createDatabase: false });
      const app = yield* Prisma.App("Web", { project });
      const deployment = yield* Prisma.Deployment("Deployment", {
        app,
        artifactPath: controlArtifactPath,
        portMapping: { http: null },
        start: true,
      });
      return { project, app, deployment };
    });

    const deployed = yield* stack.deploy(resources);
    const deploymentId = deployed.deployment.deploymentId;
    expect(deployed.deployment.status).toBe("running");
    expect(deployed.deployment.artifactHash).toBeDefined();
    expect(deployed.deployment.appEndpointDomain).toBeUndefined();
    const observed = yield* observeDeployment(deploymentId);
    expect(observed.status).toBe("running");
    expect(observed.serviceId).toBe(deployed.app.appId);
    const previewUrl = Prisma.toDeploymentUrl(deployed.deployment.previewDomain ?? undefined)!;
    expect(yield* fetchText(previewUrl)).toBe("control");

    // Asserted start always reconciles, even with unchanged props.
    const plan = yield* stack.plan(resources);
    expect(plan.resources.Deployment?.action).toBe("update");

    // The server now outlives SIGTERM by longer than the provider's
    // two-minute stop wait, so the deployment stays `stopping`.
    expect(yield* fetchText(`${previewUrl}/hold?seconds=150`)).toBe("holding 150s");
    const failed = yield* failureOf(stack.destroy());
    expect(failed.text).toContain("DeleteInProgress");
    expect(failed.text).toContain("last status: 'stopping'");
    expect(failed.text).toContain("only a stopped deployment can be deleted");
    expect((yield* observeDeployment(deploymentId)).status).toBe("stopping");

    // Once the stop drains, the retried delete completes.
    expect((yield* waitForStatus(deploymentId, "stopped", 18)).status).toBe("stopped");
    yield* stack.destroy();
    yield* expectDeploymentGone(deploymentId);
    yield* expectAppGone(deployed.app.appId);
    yield* expectProjectGone(deployed.project.projectId);
  }),
  { tags: liveTags, timeout: 300_000 },
);

live.test.provider(
  "replaces a terminal failed deployment, refreshes through the recorded App ID, and recovers a lost deployment ID by its Foundry version",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();
    const identity = { name: stack.name, stage: stack.stage };
    const detect = Drift.detect(identity).pipe(Effect.provide(stack.state));

    const resources = Effect.gen(function* () {
      const project = yield* Prisma.Project("Project", { createDatabase: false });
      const web = yield* Prisma.App("Web", { project });
      const admin = yield* Prisma.App("Admin", { project });
      const deployment = yield* Prisma.Deployment("Deployment", {
        app: web,
        artifactPath: artifactV1Path,
        promote: true,
      });
      return { project, web, admin, deployment };
    });

    const initial = yield* stack.deploy(resources);
    const webId = initial.web.appId;

    // Foundry's failed status is terminal: a deployment recorded as failed
    // is replaced, and the replacement is promoted before the old one goes.
    yield* patchStateAttr(stack, "Deployment", { status: "failed" });
    const plan = yield* stack.plan(resources);
    expect(plan.resources.Deployment?.action).toBe("replace");
    const replaced = yield* stack.deploy(resources);
    const deploymentId = replaced.deployment.deploymentId;
    expect(deploymentId).not.toBe(initial.deployment.deploymentId);
    expect(replaced.deployment.status).toBe("running");
    yield* expectDeploymentGone(initial.deployment.deploymentId);
    expect((yield* observeApp(webId)).latestDeploymentId).toBe(deploymentId);

    // The App ID recorded in the attributes, not the one in the props, owns
    // the deployment: membership is checked against Web, not Admin.
    const row = yield* stateRow(stack, "Deployment");
    const recordedApp = (row.props as { app: unknown }).app;
    yield* patchStateProps(stack, "Deployment", {
      app: { ...(recordedApp as object), appId: initial.admin.appId },
    });
    const throughRecorded = yield* detect;
    expect(throughRecorded.resources.Deployment?.action).not.toBe("missing");
    expect(throughRecorded.resources.Deployment).toMatchObject({
      attr: { deploymentId, appId: webId },
    });
    yield* patchStateProps(stack, "Deployment", { app: recordedApp });

    // The saved deployment ID no longer resolves, but the recorded Foundry
    // version finds the deployment in the App.
    yield* patchStateAttr(stack, "Deployment", {
      deploymentId: `${deploymentId.slice(0, -4)}zzzz`,
    });
    const recovered = yield* detect;
    expect(recovered.resources.Deployment).toMatchObject({
      action: "drifted",
      attr: { deploymentId, appId: webId },
    });
    const repaired = yield* Drift.repair(identity).pipe(Effect.provide(stack.state));
    expect(repaired.resources.Deployment).toMatchObject({
      action: "repaired",
      attr: { deploymentId, appId: webId },
    });
    expect((yield* stateRow(stack, "Deployment")).attr).toMatchObject({ deploymentId });

    yield* stack.destroy();
    yield* expectDeploymentGone(deploymentId);
    yield* expectAppGone(webId);
    yield* expectAppGone(initial.admin.appId);
    yield* expectProjectGone(initial.project.projectId);
  }),
  { tags: liveTags, timeout: 240_000 },
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
