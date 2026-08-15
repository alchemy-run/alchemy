import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as environment from "@distilled.cloud/vercel/environment";
import * as projects from "@distilled.cloud/vercel/projects";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Deterministic host-project names — one per test so concurrently running
// tests never fight over a fixture.
const HOST_LIFECYCLE_A = "alchemy-sharedenv-host-a";
const HOST_LIFECYCLE_B = "alchemy-sharedenv-host-b";
const HOST_SENSITIVE = "alchemy-sharedenv-host-sensitive";

// Shared env var keys are team-global; deterministic and suite-unique.
const KEY = "ALCHEMY_TEST_SHARED_ENV";
const SENSITIVE_KEY = "ALCHEMY_TEST_SHARED_SENSITIVE";
const RECOVERY_KEY = "ALCHEMY_TEST_SHARED_RECOVERY";

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

/** Bounded typed wait-until-gone. */
const expectSharedEnvGone = (id: string, scope: { teamId?: string }) =>
  Effect.gen(function* () {
    const gone = yield* environment.getSharedEnvVar({ id, ...scope }).pipe(
      Effect.map(() => false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (g) => g,
        times: 10,
      }),
    );
    expect(gone).toBe(true);
  });

test.provider("create, update, relink, and destroy a shared env var", (stack) =>
  Effect.gen(function* () {
    const scope = yield* teamScopeOf;
    const projectA = yield* ensureHostProject(HOST_LIFECYCLE_A, scope);
    const projectB = yield* ensureHostProject(HOST_LIFECYCLE_B, scope);
    yield* Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vercel.SharedEnv("Var", {
            key: KEY,
            value: "one",
            target: ["production", "preview"],
            projects: [projectA],
            comment: "alchemy test",
          });
        }),
      );
      expect(created.sharedEnvId).toMatch(/^env_/);
      expect(created.key).toEqual(KEY);
      expect(created.type).toEqual("encrypted");
      expect([...created.target].sort()).toEqual(["preview", "production"]);
      expect(created.projectIds).toEqual([projectA]);
      expect(created.comment).toEqual("alchemy test");

      // Out-of-band verification via distilled: encrypted values are
      // readable back, links and targets landed.
      const observed = yield* environment.getSharedEnvVar({
        id: created.sharedEnvId,
        ...scope,
      });
      expect(observed.value).toEqual("one");
      expect([...(observed.target ?? [])].sort()).toEqual([
        "preview",
        "production",
      ]);
      expect(observed.projectId).toEqual([projectA]);

      // No-op redeploy: same identity, no spurious update.
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vercel.SharedEnv("Var", {
            key: KEY,
            value: "one",
            target: ["production", "preview"],
            projects: [projectA],
            comment: "alchemy test",
          });
        }),
      );
      expect(second.sharedEnvId).toEqual(created.sharedEnvId);
      expect(second.updatedAt).toEqual(created.updatedAt);

      // Update in place: new value, narrower target, relink A -> B,
      // new comment. Identity (id) is stable.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vercel.SharedEnv("Var", {
            key: KEY,
            value: "two",
            target: ["production"],
            projects: [projectB],
            comment: "alchemy test 2",
          });
        }),
      );
      expect(updated.sharedEnvId).toEqual(created.sharedEnvId);
      expect(updated.target).toEqual(["production"]);
      expect(updated.projectIds).toEqual([projectB]);
      expect(updated.comment).toEqual("alchemy test 2");

      const observedUpdated = yield* environment.getSharedEnvVar({
        id: created.sharedEnvId,
        ...scope,
      });
      expect(observedUpdated.value).toEqual("two");
      expect(observedUpdated.projectId).toEqual([projectB]);
      expect(observedUpdated.target).toEqual(["production"]);

      yield* stack.destroy();
      yield* expectSharedEnvGone(created.sharedEnvId, scope);

      // Idempotent destroy: destroying again (already gone) must not fail.
      yield* stack.destroy();
    }).pipe(
      Effect.ensuring(
        Effect.andThen(
          deleteHostProject(HOST_LIFECYCLE_A, scope),
          deleteHostProject(HOST_LIFECYCLE_B, scope),
        ),
      ),
    );
  }).pipe(logLevel),
);

test.provider(
  "sensitive values are write-only and drift-corrected by content hash",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* teamScopeOf;
      const projectId = yield* ensureHostProject(HOST_SENSITIVE, scope);
      yield* Effect.gen(function* () {
        yield* stack.destroy();

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.SharedEnv("Sens", {
              key: SENSITIVE_KEY,
              value: "s3cret-1",
              type: "sensitive",
              target: ["production"],
              projects: [projectId],
            });
          }),
        );
        expect(created.type).toEqual("sensitive");
        expect(created.valueHash).toBeDefined();

        // The plaintext never comes back from the API.
        const observed = yield* environment.getSharedEnvVar({
          id: created.sharedEnvId,
          ...scope,
        });
        expect(observed.type).toEqual("sensitive");
        expect(observed.value).not.toEqual("s3cret-1");

        // No-op redeploy: the persisted content hash matches, so no write.
        const second = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.SharedEnv("Sens", {
              key: SENSITIVE_KEY,
              value: "s3cret-1",
              type: "sensitive",
              target: ["production"],
              projects: [projectId],
            });
          }),
        );
        expect(second.sharedEnvId).toEqual(created.sharedEnvId);
        expect(second.valueHash).toEqual(created.valueHash);
        expect(second.updatedAt).toEqual(created.updatedAt);

        // Value change: hash drift forces a write even though the cloud
        // value is unreadable.
        const rotated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.SharedEnv("Sens", {
              key: SENSITIVE_KEY,
              value: "s3cret-2",
              type: "sensitive",
              target: ["production"],
              projects: [projectId],
            });
          }),
        );
        expect(rotated.sharedEnvId).toEqual(created.sharedEnvId);
        expect(rotated.valueHash).not.toEqual(created.valueHash);

        yield* stack.destroy();
        yield* expectSharedEnvGone(created.sharedEnvId, scope);
      }).pipe(Effect.ensuring(deleteHostProject(HOST_SENSITIVE, scope)));
    }).pipe(logLevel),
);

test.provider(
  "converges an existing key on create and tolerates out-of-band deletion",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* teamScopeOf;
      // Pre-create the key out-of-band — the reconciler must observe it by
      // key and sync it in place (crash recovery / SQS-style name
      // observation), never create a duplicate.
      const pre = yield* environment.createSharedEnvVariable({
        evs: [{ key: RECOVERY_KEY, value: "pre" }],
        type: "encrypted",
        target: ["production"],
        ...scope,
      });
      const preId = pre.created[0]?.id;
      expect(preId).toBeDefined();
      yield* Effect.gen(function* () {
        yield* stack.destroy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.SharedEnv("Rec", {
              key: RECOVERY_KEY,
              value: "post",
              target: ["production"],
            });
          }),
        );
        expect(deployed.sharedEnvId).toEqual(preId);

        const observed = yield* environment.getSharedEnvVar({
          id: deployed.sharedEnvId,
          ...scope,
        });
        expect(observed.value).toEqual("post");

        // Out-of-band deletion: destroy must catch the typed NotFound and
        // succeed anyway (idempotent delete).
        yield* environment.deleteSharedEnvVariable({
          ids: [deployed.sharedEnvId],
          ...scope,
        });
        yield* stack.destroy();
      }).pipe(
        Effect.ensuring(
          // Belt-and-braces: never leak the deterministic key.
          preId !== undefined
            ? environment
                .deleteSharedEnvVariable({ ids: [preId], ...scope })
                .pipe(Effect.ignore)
            : Effect.void,
        ),
      );
    }).pipe(logLevel),
);
