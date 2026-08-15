import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as projects from "@distilled.cloud/vercel/projects";
import * as sandboxes from "@distilled.cloud/vercel/sandboxes";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Deterministic names — same on every run. The sandbox is tiny (default
// resources, 2-minute hard timeout, non-persistent) and is deleted at the
// end of the test regardless of outcome.
const PROBE_PROJECT = "alchemy-test-sandbox-snapshot";
const SANDBOX_NAME = "alchemy-test-snap-sbx";

const teamScopeOf = Effect.gen(function* () {
  const { teamId } = yield* Vercel.VercelEnvironment.current;
  return teamId;
});

const ensureProbeProject = Effect.gen(function* () {
  const teamId = yield* teamScopeOf;
  return yield* projects.getProject({ idOrName: PROBE_PROJECT, teamId }).pipe(
    Effect.map((p) => p.id),
    Effect.catchTag("NotFound", () =>
      projects
        .createProject({ name: PROBE_PROJECT, teamId })
        .pipe(Effect.map((p) => p.id)),
    ),
  );
});

/** Best-effort cleanup: stop the session, delete the sandbox + project. */
const cleanup = (projectId: string, sessionId: string | undefined) =>
  Effect.gen(function* () {
    const teamId = yield* teamScopeOf;
    if (sessionId !== undefined) {
      yield* sandboxes.stopSession({ sessionId, teamId }).pipe(Effect.ignore);
    }
    yield* sandboxes
      .deleteSandbox({ name: SANDBOX_NAME, projectId, teamId })
      .pipe(Effect.ignore);
    yield* projects
      .deleteProject({ idOrName: PROBE_PROJECT, teamId })
      .pipe(Effect.ignore);
  });

test.provider(
  "snapshot a live sandbox session, redeploy idempotently, and destroy",
  (stack) =>
    Effect.gen(function* () {
      const teamId = yield* teamScopeOf;
      const projectId = yield* ensureProbeProject;
      let sessionId: string | undefined;

      yield* Effect.gen(function* () {
        yield* stack.destroy();

        // Boot a tiny throwaway sandbox session to snapshot.
        const booted = yield* sandboxes.createSandboxesV3({
          projectId,
          name: SANDBOX_NAME,
          timeout: 120_000,
          persistent: false,
          teamId,
        });
        sessionId = booted.session.id;
        expect(booted.session.status).toEqual("running");

        // Deploy the snapshot resource against the running session.
        const snapshot = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.SandboxSnapshot("Snap", {
              sessionId: booted.session.id,
            });
          }),
        );
        expect(snapshot.snapshotId).toMatch(/^snap_/);
        expect(snapshot.sourceSessionId).toEqual(booted.session.id);
        expect(snapshot.status).toEqual("created");
        expect(snapshot.sizeBytes).toBeGreaterThan(0);

        // Out-of-band verification via distilled.
        const observed = yield* sandboxes.getSessionSnapshot({
          snapshotId: snapshot.snapshotId,
          teamId,
        });
        expect(observed.snapshot.id).toEqual(snapshot.snapshotId);
        expect(observed.snapshot.status).toEqual("created");

        // Idempotent redeploy — the existing snapshot is observed, not
        // re-taken.
        const again = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.SandboxSnapshot("Snap", {
              sessionId: booted.session.id,
            });
          }),
        );
        expect(again.snapshotId).toEqual(snapshot.snapshotId);

        // Destroy deletes the snapshot (platform soft-delete).
        yield* stack.destroy();
        const after = yield* Effect.result(
          sandboxes.getSessionSnapshot({
            snapshotId: snapshot.snapshotId,
            teamId,
          }),
        );
        if (Result.isSuccess(after)) {
          expect(after.success.snapshot.status).toEqual("deleted");
        } else {
          expect(after.failure._tag).toBe("NotFound");
        }
      }).pipe(
        // `sessionId` is assigned mid-flight — suspend so cleanup sees it.
        Effect.ensuring(
          Effect.suspend(() => cleanup(projectId, sessionId)).pipe(
            Effect.ignore,
          ),
        ),
      );
    }).pipe(logLevel),
  { timeout: 120_000 },
);
