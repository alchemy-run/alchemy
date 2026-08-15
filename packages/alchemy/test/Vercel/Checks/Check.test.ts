import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as checks from "@distilled.cloud/vercel/checks_v2";
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

// Deterministic host-project name.
const HOST_LIFECYCLE = "alchemy-checks-host-lifecycle";
const NAME_RENAMED = "alchemy-test-check-renamed";

const teamScopeOf = Effect.gen(function* () {
  const { teamId } = yield* Vercel.VercelEnvironment.current;
  return teamId === undefined ? {} : { teamId };
});

// Out-of-band host-project fixture (NOT the Vercel.Project resource).
const ensureHostProject = (name: string, scope: { teamId?: string }) =>
  Effect.gen(function* () {
    yield* projects
      .deleteProject({ idOrName: name, ...scope })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
    const created = yield* projects.createProject({ name, ...scope });
    return created.id;
  });

const deleteHostProject = (name: string, scope: { teamId?: string }) =>
  projects.deleteProject({ idOrName: name, ...scope }).pipe(Effect.ignore);

/** Bounded typed wait-until-gone (uses the patched typed NotFound). */
const expectCheckGone = (
  projectId: string,
  checkId: string,
  scope: { teamId?: string },
) =>
  Effect.gen(function* () {
    const gone = yield* checks
      .getProjectCheck({ projectIdOrName: projectId, checkId, ...scope })
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
  "create, no-op redeploy, update, and destroy a project check",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* teamScopeOf;
      const projectId = yield* ensureHostProject(HOST_LIFECYCLE, scope);
      yield* Effect.gen(function* () {
        yield* stack.destroy();

        // Create with the engine-generated deterministic name and defaults
        // (requires deployment-url, blocks none). Registered with a
        // personal/team token — checks v2 is NOT integration-gated
        // (live-verified 2026-08-13).
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.Check("Check", { project: projectId });
          }),
        );
        expect(created.checkId).toMatch(/^chk_/);
        expect(created.projectId).toEqual(projectId);
        expect(created.requires).toEqual("deployment-url");
        expect(created.blocks).toEqual("none");
        expect(created.sourceKind).toEqual("webhook");

        // Out-of-band verification via distilled.
        const observed = yield* checks.getProjectCheck({
          projectIdOrName: projectId,
          checkId: created.checkId,
          ...scope,
        });
        expect(observed.name).toEqual(created.name);
        expect(observed.blocks).toEqual("none");

        // No-op redeploy: same identity, updatedAt untouched (no PATCH).
        const second = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.Check("Check", { project: projectId });
          }),
        );
        expect(second.checkId).toEqual(created.checkId);
        expect(second.updatedAt).toEqual(created.updatedAt);

        // Update in place: rename + gate aliasing + rerequestable + timeout.
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.Check("Check", {
              project: projectId,
              name: NAME_RENAMED,
              blocks: "deployment-alias",
              isRerequestable: true,
              timeout: 600,
            });
          }),
        );
        expect(updated.checkId).toEqual(created.checkId);
        expect(updated.name).toEqual(NAME_RENAMED);
        expect(updated.blocks).toEqual("deployment-alias");
        expect(updated.isRerequestable).toEqual(true);
        expect(updated.timeout).toEqual(600);

        const observedUpdated = yield* checks.getProjectCheck({
          projectIdOrName: projectId,
          checkId: created.checkId,
          ...scope,
        });
        expect(observedUpdated.name).toEqual(NAME_RENAMED);
        expect(observedUpdated.blocks).toEqual("deployment-alias");

        yield* stack.destroy();
        yield* expectCheckGone(projectId, created.checkId, scope);
      }).pipe(Effect.ensuring(deleteHostProject(HOST_LIFECYCLE, scope)));
    }).pipe(logLevel),
  { timeout: 120_000 },
);
