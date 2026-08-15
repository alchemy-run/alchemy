import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as microfrontends from "@distilled.cloud/vercel/microfrontends";
import * as projects from "@distilled.cloud/vercel/projects";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Vercel.providers() });

/**
 * ⚠️ BILLING GATE — Microfrontends is a PAID flat-rate add-on: enabling it
 * bills **$250/month per group, immediately**. Three ungated runs of this
 * suite billed $750 on 2026-08-13. Every live test here MUST stay behind
 * VERCEL_TEST_MICROFRONTENDS=1; never remove this gate without an explicit
 * billing sign-off.
 */
const MFE_BILLING_GATE = !process.env.VERCEL_TEST_MICROFRONTENDS;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Deterministic host-project names.
const HOST_DEFAULT = "alchemy-mfe-host-default";
const HOST_CHILD = "alchemy-mfe-host-child";
const GROUP_RENAMED = "alchemy-test-mfe-renamed";

const teamScopeOf = Effect.gen(function* () {
  const { teamId } = yield* Vercel.VercelEnvironment.current;
  return teamId === undefined ? {} : { teamId };
});

// Out-of-band host-project fixtures (NOT the Vercel.Project resource).
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

const findGroup = (groupId: string, scope: { teamId?: string }) =>
  microfrontends
    .getMicrofrontendsGroups(scope)
    .pipe(
      Effect.map(({ groups }) => groups.find((g) => g.group.id === groupId)),
    );

/** Bounded typed wait-until-gone (the group listing is the observe surface). */
const expectGroupGone = (groupId: string, scope: { teamId?: string }) =>
  Effect.gen(function* () {
    const gone = yield* findGroup(groupId, scope).pipe(
      Effect.map((entry) => entry === undefined),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (g) => g,
        times: 10,
      }),
    );
    expect(gone).toBe(true);
  });

test.provider.skipIf(MFE_BILLING_GATE)(
  "create, sync membership, rename, and destroy a microfrontends group",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* teamScopeOf;
      const defaultId = yield* ensureHostProject(HOST_DEFAULT, scope);
      const childId = yield* ensureHostProject(HOST_CHILD, scope);
      yield* Effect.gen(function* () {
        yield* stack.destroy();

        // Create with the engine-generated deterministic name, a default
        // app, and one child application.
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.MicrofrontendsGroup("Group", {
              defaultApp: { projectId: defaultId },
              applications: [{ projectId: childId, defaultRoute: "/docs" }],
            });
          }),
        );
        expect(created.groupId).toMatch(/^mfe_/);
        expect(created.defaultAppProjectId).toEqual(defaultId);
        expect(created.applicationProjectIds).toEqual([childId]);

        // Out-of-band verification via distilled: group listed, both
        // projects enabled, child carries its default route.
        const observed = yield* findGroup(created.groupId, scope);
        expect(observed).toBeDefined();
        expect(observed?.group.name).toEqual(created.name);
        const observedChild = observed?.projects.find((p) => p.id === childId);
        expect(observedChild?.microfrontends?.enabled).toEqual(true);
        expect(observedChild?.microfrontends?.defaultRoute).toEqual("/docs");
        expect(observedChild?.microfrontends?.isDefaultApp).toEqual(false);

        // No-op redeploy: same identity.
        const second = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.MicrofrontendsGroup("Group", {
              defaultApp: { projectId: defaultId },
              applications: [{ projectId: childId, defaultRoute: "/docs" }],
            });
          }),
        );
        expect(second.groupId).toEqual(created.groupId);

        // Rename + change the child's default route — update, not replace.
        const renamed = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.MicrofrontendsGroup("Group", {
              name: GROUP_RENAMED,
              defaultApp: { projectId: defaultId },
              applications: [{ projectId: childId, defaultRoute: "/kb" }],
            });
          }),
        );
        expect(renamed.groupId).toEqual(created.groupId);
        expect(renamed.name).toEqual(GROUP_RENAMED);

        const observedRenamed = yield* findGroup(created.groupId, scope);
        expect(observedRenamed?.group.name).toEqual(GROUP_RENAMED);
        expect(
          observedRenamed?.projects.find((p) => p.id === childId)
            ?.microfrontends?.defaultRoute,
        ).toEqual("/kb");

        // Remove the child — membership converges exactly.
        const shrunk = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.MicrofrontendsGroup("Group", {
              name: GROUP_RENAMED,
              defaultApp: { projectId: defaultId },
              applications: [],
            });
          }),
        );
        expect(shrunk.groupId).toEqual(created.groupId);
        expect(shrunk.applicationProjectIds).toEqual([]);

        yield* stack.destroy();
        yield* expectGroupGone(created.groupId, scope);
      }).pipe(
        Effect.ensuring(
          Effect.all([
            deleteHostProject(HOST_DEFAULT, scope),
            deleteHostProject(HOST_CHILD, scope),
          ]),
        ),
      );
    }).pipe(logLevel),
  { timeout: 120_000 },
);
