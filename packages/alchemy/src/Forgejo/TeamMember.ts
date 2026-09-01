import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  ForgejoCredentials,
  ignoreInaccessible,
  optional,
  paginate,
} from "./Client.ts";
import { listAccessibleOrganizations } from "./Lists.ts";
import type * as Forgejo from "./Providers.ts";

/**
 * Desired Forgejo team membership.
 */
export interface TeamMemberProps {
  /**
   * Numeric team ID.
   */
  readonly teamId: number;
  /**
   * Member login.
   */
  readonly username: string;
}

/**
 * Observed Forgejo team membership attributes.
 */
export interface TeamMemberAttributes {
  /**
   * Team ID.
   */
  readonly teamId: number;
  /**
   * Member login.
   */
  readonly username: string;
}

/**
 * A Forgejo team-member relationship resource.
 */
export interface TeamMember extends Resource<
  "Forgejo.TeamMember",
  TeamMemberProps,
  TeamMemberAttributes,
  never,
  Forgejo.Providers
> {}

/**
 * Membership of one user in a Forgejo team.
 *
 * Membership is modeled as its own resource so members can be added and
 * removed individually, rather than a parent resource overwriting the whole
 * roster on every deploy.
 *
 * ### Adding a Member
 * **Example:** Add a User to a Team
 * ```typescript
 * const team = yield* Forgejo.Team("reviewers", {
 *   organization: "acme",
 *   name: "reviewers",
 * });
 *
 * yield* Forgejo.TeamMember("alice", {
 *   teamId: team.teamId,
 *   username: "alice",
 * });
 * ```
 *
 * @resource
 */
export const TeamMember = Resource<TeamMember>("Forgejo.TeamMember");

const path = (props: TeamMemberProps) =>
  `/teams/${props.teamId}/members/${encodeURIComponent(props.username)}`;

/**
 * Provider layer implementing team-membership lifecycle.
 */
export const TeamMemberProvider = () =>
  Provider.succeed(TeamMember, {
    diff: ({ news, olds }) =>
      Effect.succeed(
        isResolved(news) &&
          olds !== undefined &&
          (news.teamId !== olds.teamId || news.username !== olds.username)
          ? { action: "replace" as const }
          : undefined,
      ),
    list: Effect.fn(function* () {
      const client = yield* ForgejoCredentials;
      const organizations = yield* listAccessibleOrganizations();
      const teams = yield* Effect.forEach(
        organizations,
        (organization) =>
          ignoreInaccessible(
            paginate<{ readonly id: number }>(
              client,
              `/orgs/${encodeURIComponent(organization.username)}/teams`,
            ),
            [] as readonly { readonly id: number }[],
          ),
        { concurrency: 8 },
      );
      const members = yield* Effect.forEach(
        teams.flat(),
        (team) =>
          ignoreInaccessible(
            paginate<{ readonly login: string }>(
              client,
              `/teams/${team.id}/members`,
            ),
            [] as readonly { readonly login: string }[],
          ).pipe(
            Effect.map((users) =>
              users.map((user) => ({
                teamId: team.id,
                username: user.login,
              })),
            ),
          ),
        { concurrency: 8 },
      );
      return members.flat();
    }),
    read: Effect.fn(function* ({ olds }) {
      const client = yield* ForgejoCredentials;
      const observed = yield* optional(
        client.request<{ readonly login: string }>("GET", path(olds)),
      );
      return observed === undefined
        ? undefined
        : { teamId: olds.teamId, username: olds.username };
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const client = yield* ForgejoCredentials;
      // Membership is existence-only: adding an existing member is a no-op
      // on Forgejo's side, so the observation is folded into the write.
      yield* client.request<void>("PUT", path(news));
      return { teamId: news.teamId, username: news.username };
    }),
    delete: Effect.fn(function* ({ olds }) {
      const client = yield* ForgejoCredentials;
      yield* optional(client.request<void>("DELETE", path(olds)));
    }),
  });
