import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as environment from "@distilled.cloud/vercel/environment";
import * as projects from "@distilled.cloud/vercel/projects";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Pro teams allow 1 custom environment per project; the multi-environment
// lifecycle below runs only on an entitled (Enterprise / raised-limit)
// account with VERCEL_TEST_CUSTOM_ENVS=1. The single-environment lifecycle
// and the limit probe are ungated.
const MULTI_ENV = !!process.env.VERCEL_TEST_CUSTOM_ENVS;

// Deterministic host-project names — one per test so concurrently running
// tests never fight over a fixture.
const HOST_LIFECYCLE = "alchemy-environments-host-lifecycle";
const HOST_REPLACE_A = "alchemy-environments-host-replace-a";
const HOST_REPLACE_B = "alchemy-environments-host-replace-b";
const HOST_LIMIT = "alchemy-environments-host-limit";
const HOST_MULTI = "alchemy-environments-host-multi";

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
const expectEnvironmentGone = (
  projectId: string,
  environmentId: string,
  scope: { teamId?: string },
) =>
  Effect.gen(function* () {
    const gone = yield* environment
      .getCustomEnvironment({
        idOrName: projectId,
        environmentSlugOrId: environmentId,
        ...scope,
      })
      .pipe(
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

test.provider(
  "create, update in place, and destroy a custom environment",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* teamScopeOf;
      const projectId = yield* ensureHostProject(HOST_LIFECYCLE, scope);
      yield* Effect.gen(function* () {
        yield* stack.destroy();

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.CustomEnvironment("Env", {
              project: projectId,
              description: "initial",
            });
          }),
        );
        expect(created.environmentId).toMatch(/^env_/);
        expect(created.projectId).toEqual(projectId);
        expect(created.type).toEqual("preview");
        // Auto-generated slug: lowercase, within Vercel's 32-char limit.
        expect(created.slug.length).toBeLessThanOrEqual(32);
        expect(created.slug).toEqual(created.slug.toLowerCase());
        expect(created.description).toEqual("initial");

        // Out-of-band verification via distilled.
        const observed = yield* environment.getCustomEnvironment({
          idOrName: projectId,
          environmentSlugOrId: created.environmentId,
          ...scope,
        });
        expect(observed.slug).toEqual(created.slug);
        expect(observed.description).toEqual("initial");

        // No-op redeploy: same identity, no spurious update.
        const second = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.CustomEnvironment("Env", {
              project: projectId,
              description: "initial",
            });
          }),
        );
        expect(second.environmentId).toEqual(created.environmentId);
        expect(second.updatedAt).toEqual(created.updatedAt);

        // Update in place: explicit slug rename + description + matcher.
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.CustomEnvironment("Env", {
              project: projectId,
              slug: "alch-env-renamed",
              description: "updated",
              branchMatcher: { type: "startsWith", pattern: "release/" },
            });
          }),
        );
        expect(updated.environmentId).toEqual(created.environmentId);
        expect(updated.slug).toEqual("alch-env-renamed");
        expect(updated.description).toEqual("updated");
        expect(updated.branchMatcher).toEqual({
          type: "startsWith",
          pattern: "release/",
        });

        // Removing the matcher converges (PATCH branchMatcher: null).
        const cleared = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.CustomEnvironment("Env", {
              project: projectId,
              slug: "alch-env-renamed",
              description: "updated",
            });
          }),
        );
        expect(cleared.environmentId).toEqual(created.environmentId);
        expect(cleared.branchMatcher).toBeUndefined();

        yield* stack.destroy();
        yield* expectEnvironmentGone(projectId, created.environmentId, scope);

        // Idempotent destroy: a second destroy of the (now empty) stack
        // must not fail even though the environment is gone.
        yield* stack.destroy();
      }).pipe(Effect.ensuring(deleteHostProject(HOST_LIFECYCLE, scope)));
    }).pipe(logLevel),
);

test.provider("changing the project replaces the environment", (stack) =>
  Effect.gen(function* () {
    const scope = yield* teamScopeOf;
    const projectA = yield* ensureHostProject(HOST_REPLACE_A, scope);
    const projectB = yield* ensureHostProject(HOST_REPLACE_B, scope);
    yield* Effect.gen(function* () {
      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vercel.CustomEnvironment("Env", {
            project: projectA,
          });
        }),
      );
      expect(initial.projectId).toEqual(projectA);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vercel.CustomEnvironment("Env", {
            project: projectB,
          });
        }),
      );
      expect(replaced.projectId).toEqual(projectB);
      expect(replaced.environmentId).not.toEqual(initial.environmentId);

      // The old environment is gone from project A, the new one lives in B.
      yield* expectEnvironmentGone(projectA, initial.environmentId, scope);
      const observed = yield* environment.getCustomEnvironment({
        idOrName: projectB,
        environmentSlugOrId: replaced.environmentId,
        ...scope,
      });
      expect(observed.id).toEqual(replaced.environmentId);

      yield* stack.destroy();
      yield* expectEnvironmentGone(projectB, replaced.environmentId, scope);
    }).pipe(
      Effect.ensuring(
        Effect.andThen(
          deleteHostProject(HOST_REPLACE_A, scope),
          deleteHostProject(HOST_REPLACE_B, scope),
        ),
      ),
    );
  }).pipe(logLevel),
);

// Ungated entitlement probe: on a Pro team the SECOND create is rejected
// with a typed BadRequest carrying Vercel's limit message. This pins both
// the typed-error surface and the plan gating, at near-zero cost.
test.provider.skipIf(MULTI_ENV)(
  "Pro plan allows one custom environment per project: typed BadRequest on the second create",
  () =>
    Effect.gen(function* () {
      const scope = yield* teamScopeOf;
      const projectId = yield* ensureHostProject(HOST_LIMIT, scope);
      yield* Effect.gen(function* () {
        const first = yield* environment.createCustomEnvironment({
          idOrName: projectId,
          slug: "alch-limit-a",
          ...scope,
        });
        expect(first.slug).toEqual("alch-limit-a");

        const second = yield* Effect.result(
          environment.createCustomEnvironment({
            idOrName: projectId,
            slug: "alch-limit-b",
            ...scope,
          }),
        );
        if (Result.isSuccess(second)) {
          return yield* Effect.die(
            "second createCustomEnvironment unexpectedly succeeded — this account allows more than one custom environment; run with VERCEL_TEST_CUSTOM_ENVS=1",
          );
        }
        expect(second.failure._tag).toBe("BadRequest");
        if (second.failure._tag === "BadRequest") {
          expect(second.failure.message).toContain("Cannot create more than");
        }
        // Host-project deletion cascades the probe environment.
      }).pipe(Effect.ensuring(deleteHostProject(HOST_LIMIT, scope)));
    }).pipe(logLevel),
);

// Multi-environment lifecycle — needs an account whose per-project custom
// environment limit is above 1 (Enterprise / raised limit).
test.provider.skipIf(!MULTI_ENV)(
  "deploys multiple custom environments in one project",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* teamScopeOf;
      const projectId = yield* ensureHostProject(HOST_MULTI, scope);
      yield* Effect.gen(function* () {
        yield* stack.destroy();

        const { staging, qa } = yield* stack.deploy(
          Effect.gen(function* () {
            const staging = yield* Vercel.CustomEnvironment("Staging", {
              project: projectId,
              slug: "alch-multi-staging",
            });
            const qa = yield* Vercel.CustomEnvironment("Qa", {
              project: projectId,
              slug: "alch-multi-qa",
            });
            return { staging, qa };
          }),
        );
        expect(staging.environmentId).not.toEqual(qa.environmentId);

        const listed =
          yield* environment.getProjectsByIdOrNameCustomEnvironments({
            idOrName: projectId,
            ...scope,
          });
        const slugs = listed.environments.map((e) => e.slug).sort();
        expect(slugs).toEqual(["alch-multi-qa", "alch-multi-staging"]);

        yield* stack.destroy();
        yield* expectEnvironmentGone(projectId, staging.environmentId, scope);
        yield* expectEnvironmentGone(projectId, qa.environmentId, scope);
      }).pipe(Effect.ensuring(deleteHostProject(HOST_MULTI, scope)));
    }).pipe(logLevel),
);
