import * as teams from "@distilled.cloud/vercel/teams";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { listAllTeamMembers, resolveTeamId } from "./internal.ts";

export interface TeamMemberProps {
  /**
   * Email address of the user to invite to the team. Changing the email
   * replaces the membership (the old member is removed, the new one
   * invited).
   */
  email: string;
  /**
   * Role of the member in the team, e.g. `MEMBER`, `OWNER`, `DEVELOPER`,
   * `BILLING`, `VIEWER`, `CONTRIBUTOR`, `SECURITY`.
   *
   * @default "MEMBER"
   */
  role?: string;
}

export type TeamMember = Resource<
  "Vercel.TeamMember",
  TeamMemberProps,
  {
    /** The user ID of the member. */
    uid: string;
    /** The email of the member. */
    email: string;
    /** The username of the member. */
    username: string;
    /** Role of the member in the team. */
    role: string;
    /** Whether the membership was confirmed (invite accepted / approved). */
    confirmed: boolean;
    /** ID of the team the membership belongs to. */
    teamId: string;
  },
  never,
  Providers
>;

type TeamMemberAttributes = TeamMember["Attributes"];

/**
 * A membership of a user in the Vercel team, managed by email invitation.
 *
 * Inviting a user **sends a real email invitation** to that address, so the
 * resource should only ever target addresses you control. An existing
 * membership (e.g. the team owner) is reported as unowned — takeover is
 * gated behind `--adopt` / `adopt(true)`, after which the member's role is
 * managed declaratively.
 *
 * Destroying the resource removes the member from the team (idempotent —
 * an already-removed member is not an error).
 *
 * @resource
 * @section Inviting a member
 * @example Invite a developer
 * ```typescript
 * const member = yield* Vercel.TeamMember("Dev", {
 *   email: "dev@acme.com",
 *   role: "DEVELOPER",
 * });
 * ```
 *
 * @section Managing an existing membership
 * @example Adopt and manage a member's role
 * ```typescript
 * import { adopt } from "alchemy/AdoptPolicy";
 *
 * const member = yield* Vercel.TeamMember("Ops", {
 *   email: "ops@acme.com",
 *   role: "MEMBER",
 * }).pipe(adopt(true));
 * ```
 *
 * @see https://vercel.com/docs/rbac/managing-team-members
 */
export const TeamMember = Resource<TeamMember>("Vercel.TeamMember");

const findMemberByEmail = (teamId: string, email: string) =>
  Effect.gen(function* () {
    const needle = email.toLowerCase();
    const members = yield* listAllTeamMembers(teamId, email);
    return members.find((m) => m.email.toLowerCase() === needle);
  });

const toAttributes = (
  member: teams.GetTeamMembersResponse["members"][number],
  teamId: string,
): TeamMemberAttributes => ({
  uid: member.uid,
  email: member.email,
  username: member.username,
  role: member.role,
  confirmed: member.confirmed,
  teamId,
});

export const TeamMemberProvider = () =>
  Provider.succeed(TeamMember, {
    stables: ["uid", "email", "username", "teamId"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      if (!output) return undefined;
      // Membership identity IS the user — a different email is a different
      // membership.
      if (news.email !== olds.email) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const teamId = yield* resolveTeamId;
      const email = output?.email ?? olds?.email;
      if (email === undefined) return undefined;
      const observed = yield* findMemberByEmail(teamId, email);
      if (observed === undefined) return undefined;
      const attrs = toAttributes(observed, teamId);
      // An existing membership without prior state is someone's real team
      // access — gate takeover behind `--adopt`.
      return output !== undefined ? attrs : Unowned(attrs);
    }),
    list: Effect.fn(function* () {
      const teamId = yield* resolveTeamId;
      const members = yield* listAllTeamMembers(teamId);
      return members.map((m) => toAttributes(m, teamId));
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const teamId = yield* resolveTeamId;
      const desiredRole = news.role ?? "MEMBER";

      // Observe — cloud membership is authoritative.
      const observed = yield* findMemberByEmail(teamId, news.email);

      // Ensure — missing → invite. NOTE: this sends a real email
      // invitation to `news.email`.
      if (observed === undefined) {
        const invited = yield* teams.inviteUserToTeam({
          teamId,
          email: news.email,
          role: desiredRole,
        });
        return {
          uid: invited.uid,
          email: invited.email,
          username: invited.username,
          role: invited.role,
          confirmed: false,
          teamId,
        };
      }

      // Sync — apply only the role delta.
      if (observed.role !== desiredRole) {
        yield* teams.updateTeamMember({
          teamId,
          uid: observed.uid,
          role: desiredRole,
        });
        const fresh = yield* findMemberByEmail(teamId, news.email);
        return toAttributes(fresh ?? observed, teamId);
      }
      return toAttributes(observed, teamId);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* teams
        .removeTeamMember({ teamId: output.teamId, uid: output.uid })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
