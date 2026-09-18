import { Services } from "@distilled.cloud/forgejo";
import type { Team as ApiTeam } from "@distilled.cloud/forgejo/organization";
import * as Effect from "effect/Effect";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { listManageableTeams, listOrganizationTeams } from "./Lists.ts";
import { replaceWhenChanged } from "./Replacement.ts";
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

const bodyOf = (props: TeamProps) => ({
  name: props.name,
  permission: props.permission,
  description: props.description,
  includes_all_repositories: props.includesAllRepositories,
  can_create_org_repo: props.canCreateOrgRepo,
  units: props.units === undefined ? undefined : [...props.units],
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
  if (teamId !== undefined) {
    const byId = yield* Services.organization
      .orgGetTeam({ id: teamId })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    if (byId !== undefined) return byId;
  }
  // Unfiltered on purpose: the Owners team is excluded from *enumeration*
  // (see `list`), but a resource that names it explicitly still adopts it
  // rather than trying to create a second team under a taken name.
  const teams = yield* listOrganizationTeams(props.organization);
  return teams.find((team) => team.name === props.name);
});

/**
 * Provider layer implementing team lifecycle.
 */
export const TeamProvider = () =>
  Provider.succeed(Team, {
    stables: ["teamId"],
    // A team belongs to the organization it was created in; Forgejo offers
    // no way to move one, so a changed `organization` names a different team.
    diff: replaceWhenChanged<TeamProps>("organization"),
    list: Effect.fn(function* () {
      return (yield* listManageableTeams()).map(attributesOf);
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const observed = yield* observe(olds, output?.teamId);
      return observed === undefined ? undefined : attributesOf(observed);
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      // Observe: live state decides create-vs-update, so adoption and a
      // re-run after a failed state write both converge.
      const observed = yield* observe(news, output?.teamId);

      if (observed === undefined) {
        const created = yield* Services.organization.orgCreateTeam({
          org: news.organization,
          ...bodyOf(news),
        });
        return attributesOf(created);
      }

      // Sync only when the live team differs from what was declared.
      const desired = bodyOf(news);
      const updated = matchesDesired(observed, desired)
        ? observed
        : yield* Services.organization.orgEditTeam({
            id: observed.id,
            ...desired,
          });
      return attributesOf(updated);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* Services.organization
        .orgDeleteTeam({ id: output.teamId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
