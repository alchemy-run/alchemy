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
import { matchesDesired } from "./Settings.ts";
import type * as Forgejo from "./Providers.ts";

/**
 * Desired Forgejo team settings.
 */
export interface TeamProps {
  /**
   * Owning organization login.
   */
  readonly organization: string;
  /**
   * Team name.
   */
  readonly name: string;
  /**
   * Repository permission.
   */
  readonly permission?: "read" | "write" | "admin";
  /**
   * Description.
   */
  readonly description?: string;
  /**
   * Include all organization repositories.
   */
  readonly includesAllRepositories?: boolean;
  /**
   * Permit repository creation.
   */
  readonly canCreateOrgRepo?: boolean;
  /**
   * Enabled permission units.
   */
  readonly units?: readonly string[];
}

/**
 * Observed Forgejo team attributes.
 */
export interface TeamAttributes {
  /**
   * Stable numeric team ID.
   */
  readonly teamId: number;
  /**
   * Team name.
   */
  readonly name: string;
}

/**
 * A Forgejo organization team resource.
 */
export interface Team extends Resource<
  "Forgejo.Team",
  TeamProps,
  TeamAttributes,
  never,
  Forgejo.Providers
> {}

/**
 * A team within a Forgejo organization.
 *
 * A team that already exists under the same name is adopted rather than
 * duplicated. Moving a team to a different organization replaces it.
 *
 * ### Creating a Team
 * **Example:** Basic Team
 * ```typescript
 * const team = yield* Forgejo.Team("reviewers", {
 *   organization: "acme",
 *   name: "reviewers",
 * });
 * ```
 *
 * **Example:** Team with Scoped Permissions
 * ```typescript
 * yield* Forgejo.Team("platform", {
 *   organization: "acme",
 *   name: "platform",
 *   description: "Platform engineering",
 *   permission: "write",
 *   includesAllRepositories: true,
 *   canCreateOrgRepo: true,
 *   units: ["repo.code", "repo.issues", "repo.pulls"],
 * });
 * ```
 *
 * @resource
 */
export const Team = Resource<Team>("Forgejo.Team");

interface ApiTeam {
  readonly id: number;
  readonly name: string;
  readonly description?: string;
  readonly permission?: string;
  readonly includes_all_repositories?: boolean;
  readonly can_create_org_repo?: boolean;
  readonly units?: readonly string[];
}

const collection = (props: Pick<TeamProps, "organization">) =>
  `/orgs/${encodeURIComponent(props.organization)}/teams`;

const path = (teamId: number) => `/teams/${teamId}`;

const bodyOf = (props: TeamProps) => ({
  name: props.name,
  permission: props.permission,
  description: props.description,
  includes_all_repositories: props.includesAllRepositories,
  can_create_org_repo: props.canCreateOrgRepo,
  units: props.units,
});

const attributesOf = (team: ApiTeam): TeamAttributes => ({
  teamId: team.id,
  name: team.name,
});

/**
 * Locate the live team, by ID when one is already known and otherwise by name
 * within the organization. The name lookup is what lets an existing team be
 * adopted, and what makes a re-run after a partially-persisted create
 * converge instead of failing on a duplicate.
 */
const observe = Effect.fn(function* (
  props: Pick<TeamProps, "organization" | "name">,
  teamId: number | undefined,
) {
  const client = yield* ForgejoCredentials;
  if (teamId !== undefined) {
    const byId = yield* optional(client.request<ApiTeam>("GET", path(teamId)));
    if (byId !== undefined) return byId;
  }
  const teams = yield* ignoreInaccessible(
    paginate<ApiTeam>(client, collection(props)),
    [] as readonly ApiTeam[],
  );
  return teams.find((team) => team.name === props.name);
});

/**
 * Provider layer implementing team lifecycle.
 */
export const TeamProvider = () =>
  Provider.succeed(Team, {
    stables: ["teamId"],
    diff: ({ news, olds }) =>
      Effect.succeed(
        isResolved(news) &&
          olds !== undefined &&
          news.organization !== olds.organization
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
            paginate<ApiTeam>(
              client,
              collection({ organization: organization.username }),
            ),
            [] as readonly ApiTeam[],
          ),
        { concurrency: 8 },
      );
      return teams.flat().map(attributesOf);
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const observed = yield* observe(olds, output?.teamId);
      return observed === undefined ? undefined : attributesOf(observed);
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const client = yield* ForgejoCredentials;

      // Observe: live state decides create-vs-update, so adoption and a
      // re-run after a failed state write both converge.
      const observed = yield* observe(news, output?.teamId);

      if (observed === undefined) {
        const created = yield* client.request<ApiTeam>(
          "POST",
          collection(news),
          {
            body: bodyOf(news),
          },
        );
        return attributesOf(created);
      }

      // Sync only when the live team differs from what was declared.
      const desired = bodyOf(news);
      const updated = matchesDesired(observed, desired)
        ? observed
        : yield* client.request<ApiTeam>("PATCH", path(observed.id), {
            body: desired,
          });
      return attributesOf(updated);
    }),
    delete: Effect.fn(function* ({ output }) {
      if (output === undefined) return;
      const client = yield* ForgejoCredentials;
      yield* optional(client.request<void>("DELETE", path(output.teamId)));
    }),
  });
