import { Services } from "@distilled.cloud/forgejo";
import type { Team as ApiTeam } from "@distilled.cloud/forgejo/organization";
import * as Effect from "effect/Effect";
import { discovered, requireOwnership } from "./Ownership.ts";
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
   * Repository permission. Defaults to read on creation; omission preserves existing permissions.
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
   * Enabled permission units. Defaults to ["repo.code"] on creation; omission preserves existing units.
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
 * An existing team requires explicit adoption. Moving a team to a different
 * organization replaces it. New teams default to read access to repository code.
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
 * A saved ID never falls back to a name. Name discovery requires explicit adoption.
 */
const observe = Effect.fn(function* (
  props: Pick<TeamProps, "organization" | "name">,
  teamId: number | undefined,
) {
  if (teamId !== undefined) {
    const byId = yield* Services.organization
      .orgGetTeam({ id: teamId })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    return byId;
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
      return observed === undefined
        ? undefined
        : discovered(attributesOf(observed), output !== undefined);
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      // A saved ID is authoritative; a matching name is not ownership evidence.
      let observed = yield* observe(news, output?.teamId);
      if (observed !== undefined)
        yield* requireOwnership(
          output?.teamId === observed.id,
          `${news.organization}/${news.name}`,
        );
      if (observed === undefined) {
        // A missing saved ID must not redirect to another team's name.
        const conflict = yield* observe(news, undefined);
        if (conflict !== undefined)
          yield* requireOwnership(false, `${news.organization}/${news.name}`);
        observed = yield* Services.organization.orgCreateTeam({
          org: news.organization,
          ...bodyOf(news),
          permission: news.permission ?? "read",
          units: [...(news.units ?? ["repo.code"])],
        });
      }

      const desired = {
        ...bodyOf(news),
        permission:
          news.permission ??
          (news.includesAllRepositories === undefined
            ? undefined
            : observed.permission),
        units:
          news.units === undefined
            ? news.permission === undefined
              ? undefined
              : observed.units
            : [...news.units],
      };
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
