import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as accessGroups from "@distilled.cloud/vercel/access_groups";
import * as projects from "@distilled.cloud/vercel/projects";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Access Groups are an Enterprise-plan feature (see AccessGroup.test.ts for
// the ungated Forbidden probe). The lifecycle below runs only on an entitled
// account with VERCEL_TEST_ACCESS_GROUPS=1.
const ENTITLED = !!process.env.VERCEL_TEST_ACCESS_GROUPS;

// Deterministic host-project names — one per test so concurrently running
// tests never fight over a fixture.
const HOST_LIFECYCLE = "alchemy-access-groups-host-lifecycle";
const HOST_REPLACE = "alchemy-access-groups-host-replace";

const teamScopeOf = Effect.gen(function* () {
  const { teamId } = yield* Vercel.VercelEnvironment.current;
  return teamId === undefined ? {} : { teamId };
});

// Out-of-band host-project fixture (NOT the Vercel.Project resource — the
// attachment tests must not depend on a concurrently-owned provider).
// Delete-if-exists first so an interrupted previous run can't wedge the
// deterministic name.
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

test.provider.skipIf(!ENTITLED)(
  "create, verify, update role, and destroy an attachment",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* teamScopeOf;
      const projectId = yield* ensureHostProject(HOST_LIFECYCLE, scope);

      yield* Effect.gen(function* () {
        yield* stack.destroy();

        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            const group = yield* Vercel.AccessGroup("Group", {});
            const grant = yield* Vercel.AccessGroupProject("Grant", {
              accessGroup: group,
              projectId,
              role: "PROJECT_VIEWER",
            });
            return { group, grant };
          }),
        );
        expect(initial.grant.accessGroupId).toEqual(
          initial.group.accessGroupId,
        );
        expect(initial.grant.projectId).toEqual(projectId);
        expect(initial.grant.role).toEqual("PROJECT_VIEWER");

        // Out-of-band verification via distilled.
        const observed = yield* accessGroups.readAccessGroupProject({
          accessGroupIdOrName: initial.grant.accessGroupId,
          projectId,
          ...scope,
        });
        expect(observed.role).toEqual("PROJECT_VIEWER");

        // Role change is an in-place update — same (group, project) identity.
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            const group = yield* Vercel.AccessGroup("Group", {});
            const grant = yield* Vercel.AccessGroupProject("Grant", {
              accessGroup: group,
              projectId,
              role: "PROJECT_DEVELOPER",
            });
            return { group, grant };
          }),
        );
        expect(updated.grant.accessGroupId).toEqual(
          initial.grant.accessGroupId,
        );
        expect(updated.grant.role).toEqual("PROJECT_DEVELOPER");

        const observedUpdated = yield* accessGroups.readAccessGroupProject({
          accessGroupIdOrName: initial.grant.accessGroupId,
          projectId,
          ...scope,
        });
        expect(observedUpdated.role).toEqual("PROJECT_DEVELOPER");

        yield* stack.destroy();

        // Typed wait-until-gone: attachment and group both deleted.
        const attachmentGone = yield* accessGroups
          .readAccessGroupProject({
            accessGroupIdOrName: initial.grant.accessGroupId,
            projectId,
            ...scope,
          })
          .pipe(
            Effect.map(() => false),
            Effect.catchTag("NotFound", () => Effect.succeed(true)),
            // The group itself is gone too — a Forbidden here would be a
            // regression, so let anything but NotFound propagate.
          );
        expect(attachmentGone).toBe(true);

        const groupGone = yield* Effect.result(
          accessGroups.readAccessGroup({
            idOrName: initial.group.accessGroupId,
            ...scope,
          }),
        );
        expect(
          Result.isFailure(groupGone) && groupGone.failure._tag === "NotFound",
        ).toBe(true);
      }).pipe(Effect.ensuring(deleteHostProject(HOST_LIFECYCLE, scope)));
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!ENTITLED)(
  "replaces the attachment when the access group changes",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* teamScopeOf;
      const projectId = yield* ensureHostProject(HOST_REPLACE, scope);

      yield* Effect.gen(function* () {
        yield* stack.destroy();

        const initial = yield* stack.deploy(
          Effect.gen(function* () {
            const groupA = yield* Vercel.AccessGroup("GroupA", {});
            const groupB = yield* Vercel.AccessGroup("GroupB", {});
            const grant = yield* Vercel.AccessGroupProject("ReplaceGrant", {
              accessGroup: groupA,
              projectId,
              role: "PROJECT_VIEWER",
            });
            return { groupA, groupB, grant };
          }),
        );
        expect(initial.grant.accessGroupId).toEqual(
          initial.groupA.accessGroupId,
        );

        const replaced = yield* stack.deploy(
          Effect.gen(function* () {
            const groupA = yield* Vercel.AccessGroup("GroupA", {});
            const groupB = yield* Vercel.AccessGroup("GroupB", {});
            const grant = yield* Vercel.AccessGroupProject("ReplaceGrant", {
              accessGroup: groupB,
              projectId,
              role: "PROJECT_VIEWER",
            });
            return { groupA, groupB, grant };
          }),
        );
        expect(replaced.grant.accessGroupId).toEqual(
          replaced.groupB.accessGroupId,
        );

        // New attachment exists on B; old attachment on A is gone.
        const onB = yield* accessGroups.readAccessGroupProject({
          accessGroupIdOrName: replaced.groupB.accessGroupId,
          projectId,
          ...scope,
        });
        expect(onB.role).toEqual("PROJECT_VIEWER");

        const onA = yield* accessGroups
          .readAccessGroupProject({
            accessGroupIdOrName: initial.groupA.accessGroupId,
            projectId,
            ...scope,
          })
          .pipe(
            Effect.map(() => true),
            Effect.catchTag("NotFound", () => Effect.succeed(false)),
          );
        expect(onA).toBe(false);

        yield* stack.destroy();
      }).pipe(Effect.ensuring(deleteHostProject(HOST_REPLACE, scope)));
    }).pipe(logLevel),
  { timeout: 120_000 },
);
