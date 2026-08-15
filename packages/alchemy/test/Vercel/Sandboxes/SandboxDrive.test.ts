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

// Sandbox Drives are in PRIVATE BETA: on accounts without access every
// drive API call (including reads) answers a typed 403 Forbidden ("Drives
// are in private beta…" — live-verified Aug 2026). The ungated probe below
// pins that typed rejection; the full lifecycle runs only on an entitled
// account with VERCEL_TEST_SANDBOX_DRIVES=1.
const ENTITLED = !!process.env.VERCEL_TEST_SANDBOX_DRIVES;

// Deterministic out-of-band probe project — same name on every run.
const PROBE_PROJECT = "alchemy-test-sandbox-drive";

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

const deleteProbeProject = Effect.gen(function* () {
  const teamId = yield* teamScopeOf;
  yield* projects
    .deleteProject({ idOrName: PROBE_PROJECT, teamId })
    .pipe(Effect.catchTag("NotFound", () => Effect.void));
});

// Ungated probe: pins the private-beta gate as the TYPED Forbidden tag on
// both a read and a write.
test.provider.skipIf(ENTITLED)(
  "drives are private-beta gated: typed Forbidden on list and create",
  () =>
    Effect.gen(function* () {
      const teamId = yield* teamScopeOf;
      const projectId = yield* ensureProbeProject;

      const listed = yield* Effect.result(
        sandboxes.listDrives({ projectId, teamId }),
      );
      expect(Result.isFailure(listed)).toBe(true);
      if (Result.isFailure(listed)) {
        expect(listed.failure._tag).toBe("Forbidden");
        if (listed.failure._tag === "Forbidden") {
          expect(listed.failure.message).toContain("private beta");
        }
      }

      const created = yield* Effect.result(
        sandboxes.getOrCreateDrive({
          name: "alchemy-test-drive-probe",
          projectId,
          teamId,
        }),
      );
      if (Result.isSuccess(created)) {
        // The account is actually entitled — clean up and direct the
        // runner to the gated lifecycle suite.
        yield* sandboxes
          .deleteDrive({ name: "alchemy-test-drive-probe", projectId, teamId })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        return yield* Effect.die(
          "getOrCreateDrive unexpectedly succeeded — this account has drive access; run with VERCEL_TEST_SANDBOX_DRIVES=1",
        );
      }
      expect(created.failure._tag).toBe("Forbidden");
    }).pipe(Effect.ensuring(deleteProbeProject.pipe(Effect.ignore)), logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!ENTITLED)(
  "create, verify, and destroy a sandbox drive (VERCEL_TEST_SANDBOX_DRIVES=1)",
  (stack) =>
    Effect.gen(function* () {
      const teamId = yield* teamScopeOf;
      const projectId = yield* ensureProbeProject;

      yield* stack.destroy();

      const drive = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vercel.SandboxDrive("Drive", {
            project: projectId,
            maxSizeBytes: 1024 * 1024 * 1024,
          });
        }),
      );
      expect(drive.projectId).toEqual(projectId);
      expect(drive.name).toBeDefined();
      expect(drive.maxSizeBytes).toEqual(1024 * 1024 * 1024);

      // Out-of-band verification via distilled.
      const listed = yield* sandboxes.listDrives({ projectId, teamId });
      expect(listed.drives.some((d) => d.name === drive.name)).toBe(true);

      // Idempotent redeploy — same drive.
      const again = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vercel.SandboxDrive("Drive", {
            project: projectId,
            maxSizeBytes: 1024 * 1024 * 1024,
          });
        }),
      );
      expect(again.name).toEqual(drive.name);
      expect(again.createdAt).toEqual(drive.createdAt);

      yield* stack.destroy();
      const after = yield* sandboxes.listDrives({ projectId, teamId });
      expect(after.drives.some((d) => d.name === drive.name)).toBe(false);
    }).pipe(Effect.ensuring(deleteProbeProject.pipe(Effect.ignore)), logLevel),
  { timeout: 120_000 },
);
