import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as projectMembers from "@distilled.cloud/vercel/project_members";
import * as projects from "@distilled.cloud/vercel/projects";
import * as teams from "@distilled.cloud/vercel/teams";
import * as user from "@distilled.cloud/vercel/user";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const teamScope = Effect.gen(function* () {
  const { teamId } = yield* Vercel.VercelEnvironment.current;
  return teamId !== undefined ? { teamId } : {};
});

const withHostProject = <A, E, R>(
  hostName: string,
  body: (projectId: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const team = yield* teamScope;
    const host = yield* projects
      .createProject({ name: hostName, ...team })
      .pipe(
        Effect.map((p) => ({ id: p.id })),
        Effect.catchTag("Conflict", () =>
          projects
            .getProject({ idOrName: hostName, ...team })
            .pipe(Effect.map((p) => ({ id: p.id }))),
        ),
      );
    return yield* body(host.id).pipe(
      Effect.ensuring(
        projects
          .deleteProject({ idOrName: host.id, ...team })
          .pipe(Effect.ignore),
      ),
    );
  });

/**
 * Ungated probes: on this account the API token belongs to the team OWNER,
 * whom the platform refuses to assign any project role
 * (`invalid_team_and_project_role_combination`). These tests pin the typed
 * error surface and the member-list decode at near-zero cost; the full
 * lifecycle below is env-gated for accounts with a non-owner member.
 */
test.provider(
  "member list decodes on a fresh project; owner add and bogus removal are typed",
  (stack) =>
    withHostProject("alchemy-test-members-probe", (projectId) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const team = yield* teamScope;

        // Fresh project: `{members: [], pagination: {}}` decodes cleanly
        // (pins the response patch — the live pagination object is empty).
        const empty = yield* projectMembers.getProjectMembers({
          idOrName: projectId,
          ...team,
        });
        expect(empty.members).toHaveLength(0);

        // Adding the token user (team OWNER) is rejected with a typed
        // BadRequest carrying the role-combination code.
        const me = yield* user.getAuthUser({});
        const rejection = yield* Effect.result(
          projectMembers.addProjectMember({
            idOrName: projectId,
            ...team,
            uid: me.user.id,
            role: "PROJECT_DEVELOPER",
          }),
        );
        expect(Result.isFailure(rejection)).toBe(true);
        if (Result.isFailure(rejection)) {
          const error = rejection.failure;
          expect(error._tag).toEqual("BadRequest");
          if (error._tag === "BadRequest") {
            expect(error.message).toContain("Invalid role combination");
          }
        }

        // Removing a non-member surfaces as a typed NotFound (pins the
        // 404 patch on removeProjectMember).
        const removal = yield* Effect.result(
          projectMembers.removeProjectMember({
            idOrName: projectId,
            uid: me.user.id,
            ...team,
          }),
        );
        expect(Result.isFailure(removal)).toBe(true);
        if (Result.isFailure(removal)) {
          expect(removal.failure._tag).toEqual("NotFound");
        }

        // Member ops on a MISSING project surface as typed NotFound (pins
        // the 404 patch on getProjectMembers).
        const gone = yield* Effect.result(
          projectMembers.getProjectMembers({
            idOrName: "prj_alchemy_does_not_exist_123",
            ...team,
          }),
        );
        expect(Result.isFailure(gone)).toBe(true);
        if (Result.isFailure(gone)) {
          expect(gone.failure._tag).toEqual("NotFound");
        }
      }),
    ).pipe(logLevel),
  { timeout: 60_000 },
);

/**
 * Full lifecycle — requires a team with at least one confirmed non-OWNER
 * member (the platform refuses project roles for OWNERs, and the testing
 * team has only its owner). Run with VERCEL_TEST_PROJECT_MEMBERS=1 on an
 * entitled team.
 */
test.provider.skipIf(!process.env.VERCEL_TEST_PROJECT_MEMBERS)(
  "member lifecycle: add, no-op redeploy, role change in place, remove on destroy",
  (stack) =>
    withHostProject("alchemy-test-members-life", (projectId) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const { teamId } = yield* Vercel.VercelEnvironment.current;
        if (teamId === undefined) throw new Error("test requires team scope");

        // Find a confirmed non-owner member to manage.
        const teamMembers = yield* teams.getTeamMembers({
          teamId,
          limit: 100,
        });
        const candidate = teamMembers.members.find(
          (m) => m.confirmed && m.role !== "OWNER",
        );
        if (candidate === undefined) {
          throw new Error(
            "VERCEL_TEST_PROJECT_MEMBERS requires a confirmed non-OWNER team member",
          );
        }

        const created = yield* stack.deploy(
          Vercel.ProjectMember("Member", {
            projectId,
            uid: candidate.uid,
            role: "PROJECT_DEVELOPER",
          }),
        );
        expect(created.projectId).toEqual(projectId);
        expect(created.uid).toEqual(candidate.uid);
        expect(created.role).toEqual("PROJECT_DEVELOPER");
        expect(created.createdAt).toBeGreaterThan(0);

        // Out-of-band: the membership is visible.
        const team = yield* teamScope;
        const observed = yield* projectMembers.getProjectMembers({
          idOrName: projectId,
          ...team,
        });
        expect(observed.members.some((m) => m.uid === candidate.uid)).toEqual(
          true,
        );

        // Identical redeploy is a no-op.
        const noop = yield* stack.deploy(
          Vercel.ProjectMember("Member", {
            projectId,
            uid: candidate.uid,
            role: "PROJECT_DEVELOPER",
          }),
        );
        expect(noop.createdAt).toEqual(created.createdAt);

        // Role change is applied in place (remove + re-add), not a replace.
        const changed = yield* stack.deploy(
          Vercel.ProjectMember("Member", {
            projectId,
            uid: candidate.uid,
            role: "PROJECT_VIEWER",
          }),
        );
        expect(changed.uid).toEqual(candidate.uid);
        expect(changed.role).toEqual("PROJECT_VIEWER");

        // Destroy removes the membership; second destroy is idempotent.
        yield* stack.destroy();
        const afterDestroy = yield* projectMembers.getProjectMembers({
          idOrName: projectId,
          ...team,
        });
        expect(
          afterDestroy.members.some((m) => m.uid === candidate.uid),
        ).toEqual(false);
        yield* stack.destroy();
      }),
    ).pipe(logLevel),
  { timeout: 120_000 },
);
