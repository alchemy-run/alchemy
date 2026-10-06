import {
  createDeploymentStart,
  createDeploymentStop,
  createService,
  createServiceDeployment,
  getService,
} from "@distilled.cloud/prisma/management";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Prisma from "@/Prisma";
import {
  destroyApp,
  destroyDeployment,
  destroyProjectApps,
  waitForDeploymentStatus,
} from "@/Prisma/ComputeLifecycle";
import {
  startDeploymentIdempotent,
  stopDeploymentIdempotent,
} from "@/Prisma/Internal/DeploymentActions";
import * as Test from "@/Test/Alchemy";
import {
  deletedDeploymentId,
  expectDeploymentGone,
  expectServiceGone,
  faultServerDir,
} from "./fixtures/ComputeLive.ts";
import { expectProjectGone } from "./fixtures/Live.ts";

const { test } = Test.make({ providers: Prisma.providers() });

/** Fork the App's live code into a new deployment and start it. */
const startedFork = (serviceId: string) =>
  Effect.gen(function* () {
    const fork = (yield* createServiceDeployment({ serviceId, skipCodeUpload: true })).data;
    yield* startDeploymentIdempotent(fork.id);
    return fork.id;
  });

test.provider(
  "waits on, starts, stops, and destroys real deployments, Apps, and projects",
  Effect.fn(function* (stack: Test.ScratchStack) {
    yield* stack.destroy();
    const { project, app } = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Prisma.Project("Project", { createDatabase: false });
        const app = yield* Prisma.Compute("App", {
          project,
          path: faultServerDir,
          entrypoint: "server.ts",
          env: { GREETING: "lifecycle" },
          timeoutSeconds: 120,
        });
        return { project, app };
      }),
    );
    const projectId = project.projectId;
    const appId = app.appId;

    // Invalid timings fail before any observation.
    const timeoutError = yield* waitForDeploymentStatus(app.deploymentId!, "running", {
      timeoutSeconds: 0,
    }).pipe(Effect.flip);
    const intervalError = yield* waitForDeploymentStatus(app.deploymentId!, "running", {
      pollIntervalMs: Number.NaN,
    }).pipe(Effect.flip);
    expect(timeoutError.message).toContain("timeoutSeconds");
    expect(intervalError.message).toContain("pollIntervalMs");

    // A missing deployment surfaces as NotFound while waiting, and is
    // already destroyed.
    const missing = yield* deletedDeploymentId(appId);
    const notFound = yield* waitForDeploymentStatus(missing, "running").pipe(Effect.flip);
    expect(notFound._tag).toBe("NotFound");
    expect(yield* destroyDeployment(missing)).toEqual({
      deploymentId: missing,
      previousStatus: undefined,
      stopped: false,
      deleted: true,
    });

    // A deployment without an uploaded artifact cannot start: the start
    // conflict is not hidden, and a wait times out on its last status.
    const empty = (yield* createServiceDeployment({ serviceId: appId })).data.id;
    const startConflict = yield* startDeploymentIdempotent(empty).pipe(Effect.flip);
    expect(startConflict._tag).toBe("Conflict");
    const timedOut = yield* waitForDeploymentStatus(empty, "running", {
      timeoutSeconds: 3,
      pollIntervalMs: 500,
    }).pipe(Effect.flip);
    expect(timedOut.message).toContain("Timed out");
    expect(timedOut.message).toContain("last status: 'new'");
    expect(yield* destroyDeployment(empty)).toMatchObject({
      previousStatus: "new",
      stopped: false,
      deleted: true,
    });
    yield* expectDeploymentGone(empty);

    // Fork every deployment up front: Prisma answers HTTP 500 to a
    // skipCodeUpload create once a deployment sharing the code is deleted.
    const forkA = yield* startedFork(appId);
    const forkB = yield* startedFork(appId);
    const forkC = yield* startedFork(appId);

    // A start conflict on a deployment already starting or running is
    // idempotent; so is a stop conflict on one already stopping or stopped.
    expect((yield* waitForDeploymentStatus(forkA, "running", { timeoutSeconds: 90 })).status).toBe(
      "running",
    );
    yield* startDeploymentIdempotent(forkA);
    yield* stopDeploymentIdempotent(forkA);
    yield* waitForDeploymentStatus(forkA, "stopped", { timeoutSeconds: 90 });
    yield* stopDeploymentIdempotent(forkA);
    expect(yield* destroyDeployment(forkA)).toMatchObject({
      previousStatus: "stopped",
      stopped: false,
      deleted: true,
    });
    yield* expectDeploymentGone(forkA);

    // A running deployment is stopped before it is deleted; one already
    // stopping is waited out instead.
    yield* waitForDeploymentStatus(forkB, "running", { timeoutSeconds: 90 });
    expect(yield* destroyDeployment(forkB, { timeoutSeconds: 90 })).toMatchObject({
      previousStatus: "running",
      stopped: true,
      deleted: true,
    });
    yield* expectDeploymentGone(forkB);
    yield* waitForDeploymentStatus(forkC, "running", { timeoutSeconds: 90 });
    yield* createDeploymentStop({ deploymentId: forkC });
    const stopping = yield* destroyDeployment(forkC, { timeoutSeconds: 90 });
    expect(stopping.stopped).toBe(false);
    expect(stopping.deleted).toBe(true);
    expect(["stopping", "stopped"]).toContain(stopping.previousStatus);
    yield* expectDeploymentGone(forkC);

    // Project-scoped cleanup can inspect without deleting anything.
    const extraA = (yield* createService({
      projectId,
      displayName: "extra-a",
      branchGitName: "main",
    })).data.id;
    const extraB = (yield* createService({
      projectId,
      displayName: "extra-b",
      branchGitName: "main",
    })).data.id;
    expect(yield* destroyProjectApps(projectId, { keepApp: true, keepProject: true })).toEqual({
      projectId,
      deletedAppIds: [],
      projectDeleted: false,
    });
    expect((yield* getService({ serviceId: extraA })).data.id).toBe(extraA);

    // Deleting an App cascades its deployments; a gone App is already deleted.
    expect(yield* destroyApp(extraA)).toEqual({ appId: extraA, appDeleted: true });
    yield* expectServiceGone(extraA);
    expect(yield* destroyApp(extraA)).toEqual({ appId: extraA, appDeleted: true });

    // Project cleanup deletes every App, keeping the project when asked.
    const kept = yield* destroyProjectApps(projectId, { keepProject: true });
    expect(kept.projectDeleted).toBe(false);
    expect([...kept.deletedAppIds].sort()).toEqual([appId, extraB].sort());
    yield* expectServiceGone(appId);
    yield* expectServiceGone(extraB);
    yield* expectDeploymentGone(app.deploymentId!);

    expect(yield* destroyProjectApps(projectId)).toEqual({
      projectId,
      deletedAppIds: [],
      projectDeleted: true,
    });
    yield* expectProjectGone(projectId);
    // A gone project is already deleted.
    expect(yield* destroyProjectApps(projectId)).toEqual({
      projectId,
      deletedAppIds: [],
      projectDeleted: true,
    });

    yield* stack.destroy();
  }),
  {
    tags: [
      "provider:prisma",
      "provider:prisma:compute",
      "provider:prisma:deployment",
      "provider:prisma:project",
      "live",
    ],
    timeout: 300_000,
  },
);
