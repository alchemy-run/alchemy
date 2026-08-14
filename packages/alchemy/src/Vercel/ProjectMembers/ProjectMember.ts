import * as projectMembers from "@distilled.cloud/vercel/project_members";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { VercelEnvironment } from "../VercelEnvironment.ts";

/** Project-level role a team member can hold. */
export type ProjectMemberRole =
  | "ADMIN"
  | "PROJECT_VIEWER"
  | "PROJECT_DEVELOPER";

/**
 * A member was added but never became visible in the project's member list
 * within the bounded observation window.
 */
export class ProjectMemberNotVisible extends Data.TaggedError(
  "Vercel.ProjectMemberNotVisible",
)<{
  readonly projectId: string;
  readonly identity: string;
}> {
  override get message() {
    return `Project member '${this.identity}' was added to project '${this.projectId}' but did not appear in the member list.`;
  }
}

export interface ProjectMemberProps {
  /**
   * ID of the Vercel project. Changing this property replaces the resource
   * (the member is removed from the old project and added to the new one).
   */
  projectId: string;
  /**
   * User ID of the team member to add. Exactly one of `uid`, `username`, or
   * `email` must identify an EXISTING, confirmed member of the team —
   * project membership never invites new users (an unknown user is rejected
   * with a typed `BadRequest`, code `not_a_member`). Changing the identity
   * replaces the resource.
   */
  uid?: string;
  /** Username of the team member to add (alternative to `uid`). */
  username?: string;
  /** Email of the team member to add (alternative to `uid`). */
  email?: string;
  /**
   * Project role of the member. Note the platform restricts combinations:
   * a team OWNER cannot be assigned any project role (typed `BadRequest`,
   * code `invalid_team_and_project_role_combination`). Role changes are
   * applied in place (remove + re-add — the API has no update operation).
   */
  role: ProjectMemberRole;
}

export type ProjectMember = Resource<
  "Vercel.ProjectMember",
  ProjectMemberProps,
  {
    /** ID of the project the membership is attached to. */
    projectId: string;
    /** User ID of the member. */
    uid: string;
    /** Username of the member. */
    username: string;
    /** Email of the member. */
    email: string;
    /** Project role held by the member. */
    role: string;
    /** Effective project role (accounts for team-level roles). */
    computedProjectRole: string;
    /** The member's team-level role. */
    teamRole: string;
    /** Timestamp (ms) when the member was added to the project. */
    createdAt: number;
  },
  never,
  Providers
>;

type ProjectMemberAttributes = ProjectMember["Attributes"];

/**
 * A project membership: grants an existing team member a role on a specific
 * Vercel project.
 *
 * The member must already be a confirmed member of the team — this resource
 * scopes existing team members to projects, it does not invite users.
 * Platform role rules apply: team OWNERs (and other elevated team roles)
 * cannot be assigned project roles, so manage memberships for regular
 * team members (`MEMBER`, `DEVELOPER`, contributors).
 *
 * The API has no role-update operation, so a role change is reconciled by
 * removing and re-adding the membership in place.
 *
 * @resource
 * @section Adding a Project Member
 * @example Grant a developer role by user ID
 * ```typescript
 * const member = yield* Vercel.ProjectMember("Alice", {
 *   projectId: project.projectId,
 *   uid: "uAbC123...",
 *   role: "PROJECT_DEVELOPER",
 * });
 * ```
 *
 * @example Grant a viewer role by email
 * ```typescript
 * const member = yield* Vercel.ProjectMember("Auditor", {
 *   projectId: project.projectId,
 *   email: "auditor@example.com",
 *   role: "PROJECT_VIEWER",
 * });
 * ```
 *
 * @see https://vercel.com/docs/rbac/access-roles/project-level-roles
 */
export const ProjectMember = Resource<ProjectMember>("Vercel.ProjectMember");

export const ProjectMemberProvider = () =>
  Provider.succeed(ProjectMember, {
    stables: ["projectId", "uid"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      const oldProjectId = output?.projectId ?? olds?.projectId;
      if (oldProjectId !== undefined && news.projectId !== oldProjectId) {
        return { action: "replace" } as const;
      }
      // Changing WHO the member is replaces; changing the role updates.
      if (olds !== undefined) {
        const identityChanged =
          news.uid !== olds.uid ||
          news.username !== olds.username ||
          news.email !== olds.email;
        if (identityChanged) return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const projectId = output?.projectId ?? olds?.projectId;
      if (projectId === undefined) return undefined;
      const { teamId } = yield* VercelEnvironment.current;
      return yield* findMember(projectId, teamId, {
        uid: output?.uid ?? olds?.uid,
        username: olds?.username,
        email: olds?.email,
      }).pipe(
        Effect.map((member) =>
          member === undefined ? undefined : toAttributes(projectId, member),
        ),
        // NotFound = the host project itself is gone.
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const { teamId } = yield* VercelEnvironment.current;
      const projectId = news.projectId;
      const identity = {
        uid: news.uid ?? output?.uid,
        username: news.username,
        email: news.email,
      };
      // Observe — the project's member list is the source of truth.
      const observed = yield* findMember(projectId, teamId, identity);
      if (observed !== undefined) {
        if (observed.role === news.role) {
          return toAttributes(projectId, observed);
        }
        // Role change: no update op exists — remove, then re-add below.
        yield* projectMembers
          .removeProjectMember({
            idOrName: projectId,
            uid: observed.uid,
            teamId,
          })
          .pipe(
            // A concurrent removal is a race, not a failure.
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
      }
      // Ensure — add the membership with the desired role.
      yield* projectMembers.addProjectMember({
        idOrName: projectId,
        teamId,
        uid: news.uid,
        username: news.username,
        email: news.email,
        role: news.role,
      });
      // Re-observe (bounded) until the membership is visible.
      const member = yield* findMember(projectId, teamId, identity).pipe(
        Effect.repeat({
          schedule: Schedule.exponential("250 millis"),
          until: (m) => m !== undefined,
          times: 8,
        }),
      );
      if (member === undefined) {
        return yield* new ProjectMemberNotVisible({
          projectId,
          identity:
            identity.uid ?? identity.username ?? identity.email ?? "<unknown>",
        });
      }
      return toAttributes(projectId, member);
    }),
    delete: Effect.fn(function* ({ output }) {
      const { teamId } = yield* VercelEnvironment.current;
      // Idempotent: a vanished membership OR a vanished project both
      // surface as NotFound and are not errors.
      yield* projectMembers
        .removeProjectMember({
          idOrName: output.projectId,
          uid: output.uid,
          teamId,
        })
        .pipe(
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
        );
    }),
  });

// ─────────────────────────────────────────────────────────────────────────────
// Observation helpers
// ─────────────────────────────────────────────────────────────────────────────

interface MemberIdentity {
  uid?: string;
  username?: string;
  email?: string;
}

/**
 * Find a member of the project by uid/username/email, paging through the
 * member list (bounded at 10 pages of 100).
 */
const findMember = Effect.fn(function* (
  projectId: string,
  teamId: string | undefined,
  identity: MemberIdentity,
) {
  const matches = (
    member: projectMembers.GetProjectMembersResponseMembersItem,
  ): boolean =>
    (identity.uid !== undefined && member.uid === identity.uid) ||
    (identity.username !== undefined &&
      member.username === identity.username) ||
    (identity.email !== undefined && member.email === identity.email);

  let until: number | undefined = undefined;
  for (let page = 0; page < 10; page++) {
    // Explicit annotation: `until` feeds the request from the previous
    // response, which otherwise makes the inferred type self-referential.
    const response: projectMembers.GetProjectMembersResponse =
      yield* projectMembers.getProjectMembers({
        idOrName: projectId,
        teamId,
        limit: 100,
        until,
        // `search` narrows by name/username/email server-side when we have one.
        search: identity.username ?? identity.email,
      });
    const found = response.members.find(matches);
    if (found !== undefined) return found;
    if (
      response.pagination.hasNext !== true ||
      response.pagination.next == null
    ) {
      return undefined;
    }
    until = response.pagination.next;
  }
  return undefined;
});

const toAttributes = (
  projectId: string,
  member: projectMembers.GetProjectMembersResponseMembersItem,
): ProjectMemberAttributes => ({
  projectId,
  uid: member.uid,
  username: member.username,
  email: member.email,
  role: member.role,
  computedProjectRole: member.computedProjectRole,
  teamRole: member.teamRole,
  createdAt: member.createdAt,
});
