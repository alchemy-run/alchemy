import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as projects from "@distilled.cloud/vercel/projects";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Deterministic host-project names — one per test so concurrently running
// tests never fight over a fixture.
const HOST_LIFECYCLE = "alchemy-project-env-host-lifecycle";
const HOST_SENSITIVE = "alchemy-project-env-host-sensitive";
const HOST_BRANCH = "alchemy-project-env-host-branch";

const teamScopeOf = Effect.gen(function* () {
  const { teamId } = yield* Vercel.VercelEnvironment.current;
  return teamId === undefined ? {} : { teamId };
});

// Out-of-band host-project fixture (NOT the Vercel.Project resource — these
// tests must not depend on a concurrently-owned provider). Delete-if-exists
// first so an interrupted previous run can't wedge the deterministic name.
const ensureHostProject = (name: string, scope: { teamId?: string }) =>
  Effect.gen(function* () {
    yield* projects
      .deleteProject({ idOrName: name, ...scope })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
    const created = yield* projects.createProject({ name, ...scope });
    return created.id;
  });

// Finalizer-safe (used with `Effect.ensuring`): never fails.
const deleteHostProject = (name: string, scope: { teamId?: string }) =>
  projects.deleteProject({ idOrName: name, ...scope }).pipe(Effect.ignore);

/** Observed rows for a key (normalized across the response union). */
const rowsForKey = (
  projectId: string,
  key: string,
  scope: { teamId?: string },
) =>
  Effect.gen(function* () {
    const body = yield* projects.filterProjectEnvs({
      idOrName: projectId,
      decrypt: "true",
      ...scope,
    });
    const rows =
      typeof body === "object" && body !== null && "envs" in body
        ? (body.envs as Array<{
            id?: string;
            key: string;
            value?: string;
            type: string;
            comment?: string;
            target?: unknown;
            gitBranch?: string | null;
          }>)
        : [];
    return rows.filter((row) => row.key === key);
  });

/**
 * Decrypted single-row value. The LISTING returns `encrypted` values as a
 * sealed ciphertext envelope on teams with v2 env encryption (live reality
 * on this team — see PROBES.md), but the single-env GET returns plaintext.
 */
const decryptedValue = (
  projectId: string,
  envId: string,
  scope: { teamId?: string },
) =>
  Effect.gen(function* () {
    const row = yield* projects.getProjectEnv({
      idOrName: projectId,
      id: envId,
      ...scope,
    });
    return (row as { value?: string }).value;
  });

/** Bounded typed wait until no row with the key remains. */
const expectKeyGone = (
  projectId: string,
  key: string,
  scope: { teamId?: string },
) =>
  Effect.gen(function* () {
    const gone = yield* rowsForKey(projectId, key, scope).pipe(
      Effect.map((rows) => rows.length === 0),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (g) => g,
        times: 10,
      }),
    );
    expect(gone).toBe(true);
  });

test.provider(
  "create, no-op, update in place, replace on key change, destroy",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* teamScopeOf;
      const projectId = yield* ensureHostProject(HOST_LIFECYCLE, scope);
      yield* Effect.gen(function* () {
        yield* stack.destroy();

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.ProjectEnv("Flag", {
              project: projectId,
              key: "FLAG",
              value: "on",
              target: ["production"],
            });
          }),
        );
        expect(created.projectId).toEqual(projectId);
        expect(created.envId).not.toEqual("");
        expect(created.key).toEqual("FLAG");
        expect(created.type).toEqual("encrypted");
        expect(created.target).toEqual(["production"]);
        expect(created.fingerprint).toMatch(/^alchemy:sha256:/);

        // Out-of-band verification via distilled. The listing's value is a
        // sealed ciphertext envelope on v2-env-encryption teams, so the
        // decrypted value comes from the single-env GET.
        const observed = yield* rowsForKey(projectId, "FLAG", scope);
        expect(observed.length).toEqual(1);
        expect(yield* decryptedValue(projectId, created.envId, scope)).toEqual(
          "on",
        );

        // No-op redeploy: same identity, no spurious write.
        const second = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.ProjectEnv("Flag", {
              project: projectId,
              key: "FLAG",
              value: "on",
              target: ["production"],
            });
          }),
        );
        expect(second.envId).toEqual(created.envId);
        expect(second.updatedAt).toEqual(created.updatedAt);

        // Update in place: value + targets + comment.
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.ProjectEnv("Flag", {
              project: projectId,
              key: "FLAG",
              value: "off",
              target: ["production", "preview"],
              comment: "feature flag",
            });
          }),
        );
        expect(updated.envId).toEqual(created.envId);
        expect(updated.target).toEqual(["preview", "production"]);
        expect(updated.comment).toEqual("feature flag");
        expect(yield* decryptedValue(projectId, updated.envId, scope)).toEqual(
          "off",
        );

        // Renaming the key replaces the resource (new row, old key gone).
        const replaced = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.ProjectEnv("Flag", {
              project: projectId,
              key: "FLAG_V2",
              value: "off",
              target: ["production"],
            });
          }),
        );
        expect(replaced.key).toEqual("FLAG_V2");
        expect(replaced.envId).not.toEqual(created.envId);
        yield* expectKeyGone(projectId, "FLAG", scope);

        yield* stack.destroy();
        yield* expectKeyGone(projectId, "FLAG_V2", scope);

        // Idempotent destroy: a second destroy of the (now empty) stack
        // must not fail even though the row is gone.
        yield* stack.destroy();
      }).pipe(Effect.ensuring(deleteHostProject(HOST_LIFECYCLE, scope)));
    }).pipe(logLevel),
);

test.provider(
  "sensitive env var: Redacted value, write-only drift via fingerprint",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* teamScopeOf;
      const projectId = yield* ensureHostProject(HOST_SENSITIVE, scope);
      yield* Effect.gen(function* () {
        yield* stack.destroy();

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.ProjectEnv("Secret", {
              project: projectId,
              key: "API_SECRET",
              value: Redacted.make("hunter2-v1"),
            });
          }),
        );
        expect(created.type).toEqual("sensitive");
        // `development` is dropped from sensitive targets (live-verified:
        // the API rejects it).
        expect(created.target).toEqual(["preview", "production"]);
        expect(created.fingerprint).toMatch(/^alchemy:sha256:/);

        // Live-verified: sensitive rows list with an EMPTY value even with
        // decrypt=true — the value is write-only.
        const observed = yield* rowsForKey(projectId, "API_SECRET", scope);
        expect(observed.length).toEqual(1);
        expect(observed[0]!.type).toEqual("sensitive");
        expect(observed[0]!.value ?? "").toEqual("");

        // No-op redeploy: unchanged fingerprint, no spurious write.
        const second = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.ProjectEnv("Secret", {
              project: projectId,
              key: "API_SECRET",
              value: Redacted.make("hunter2-v1"),
            });
          }),
        );
        expect(second.envId).toEqual(created.envId);
        expect(second.updatedAt).toEqual(created.updatedAt);
        expect(second.fingerprint).toEqual(created.fingerprint);

        // Rotation: the value is unobservable, so drift is detected via
        // the persisted fingerprint and the row is rewritten.
        const rotated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.ProjectEnv("Secret", {
              project: projectId,
              key: "API_SECRET",
              value: Redacted.make("hunter2-v2"),
            });
          }),
        );
        expect(rotated.fingerprint).not.toEqual(created.fingerprint);

        yield* stack.destroy();
        yield* expectKeyGone(projectId, "API_SECRET", scope);
      }).pipe(Effect.ensuring(deleteHostProject(HOST_SENSITIVE, scope)));
    }).pipe(logLevel),
);

// Branch-scoped env vars require the project to have a CONNECTED GIT
// REPOSITORY (live-verified: the API rejects gitBranch on unconnected
// projects), and connecting a repo needs a Git-provider install no test can
// perform. Ungated: pin the exact typed rejection. Gated: the full lifecycle
// runs against a git-connected project named via VERCEL_TEST_GIT_PROJECT.
const GIT_PROJECT = process.env.VERCEL_TEST_GIT_PROJECT;

test.provider(
  "gitBranch on a project without a connected Git repository: typed BadRequest",
  () =>
    Effect.gen(function* () {
      const scope = yield* teamScopeOf;
      const projectId = yield* ensureHostProject(HOST_BRANCH, scope);
      yield* Effect.gen(function* () {
        const result = yield* Effect.result(
          projects.createProjectEnv({
            idOrName: projectId,
            upsert: "true",
            ...scope,
            body: [
              {
                key: "API_URL",
                value: "https://staging.api.example.com",
                type: "encrypted",
                target: ["preview"],
                gitBranch: "staging",
              },
            ],
          }),
        );
        if (Result.isSuccess(result)) {
          // Some plans may accept it via the per-item failed[] envelope
          // instead of a top-level 400 — accept either rejection shape.
          expect(result.success.failed.length).toBeGreaterThan(0);
          return;
        }
        expect(result.failure._tag).toBe("BadRequest");
        if (result.failure._tag === "BadRequest") {
          expect(result.failure.message).toContain("connected Git repository");
        }
      }).pipe(Effect.ensuring(deleteHostProject(HOST_BRANCH, scope)));
    }).pipe(logLevel),
);

test.provider.skipIf(!GIT_PROJECT)(
  "branch-scoped preview variable on a git-connected project",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* teamScopeOf;
      const projectId = GIT_PROJECT!;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vercel.ProjectEnv("StagingUrl", {
            project: projectId,
            key: "ALCHEMY_TEST_BRANCH_URL",
            value: "https://staging.api.example.com",
            target: ["preview"],
            gitBranch: "staging",
          });
        }),
      );
      expect(created.target).toEqual(["preview"]);
      expect(created.gitBranch).toEqual("staging");

      const observed = yield* rowsForKey(
        projectId,
        "ALCHEMY_TEST_BRANCH_URL",
        scope,
      );
      expect(observed.length).toEqual(1);
      expect(observed[0]!.gitBranch).toEqual("staging");

      yield* stack.destroy();
      yield* expectKeyGone(projectId, "ALCHEMY_TEST_BRANCH_URL", scope);
    }).pipe(logLevel),
);
