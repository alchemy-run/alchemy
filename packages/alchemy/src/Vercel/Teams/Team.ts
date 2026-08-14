import * as teams from "@distilled.cloud/vercel/teams";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface TeamProps {
  /**
   * The team's slug, unique across the Vercel platform. Used to create the
   * team and to resolve an existing team for adoption. If omitted, a unique
   * slug is generated from `${app}-${stage}-${id}`. Slugs are immutable via
   * the update API, so changing the slug replaces the team.
   */
  slug?: string;
  /**
   * Display name of the team.
   */
  name?: string;
  /**
   * A short text that describes the team.
   */
  description?: string;
  /**
   * Suffix used for all preview deployments of the team's projects.
   * Requires a domain-of-record on the team.
   */
  previewDeploymentSuffix?: string;
  /**
   * Whether remote caching (Turborepo) is enabled for the team.
   */
  remoteCaching?: { enabled: boolean };
  /**
   * Sensitive environment variable policy: one of `on`, `off` or `default`.
   */
  sensitiveEnvironmentVariablePolicy?: string;
  /**
   * Display or hide IP addresses in Monitoring queries.
   */
  hideIpAddresses?: boolean;
  /**
   * Display or hide IP addresses in Log Drains.
   */
  hideIpAddressesInLogDrains?: boolean;
}

export type Team = Resource<
  "Vercel.Team",
  TeamProps,
  {
    /** The team's unique identifier (`team_…`). */
    teamId: string;
    /** The team's slug, unique across the Vercel platform. */
    slug: string;
    /** Display name of the team, or `null` if none has been provided. */
    name: string | null;
    /** A short text that describes the team, or `null`. */
    description: string | null;
    /** ID of the user who created the team. */
    creatorId: string;
    /** Prefix prepended to automatic preview aliases. */
    stagingPrefix: string;
    /** Timestamp (ms) when the team was created. */
    createdAt: number;
    /** Timestamp (ms) when the team was last updated. */
    updatedAt: number;
    /**
     * Whether this team was created by alchemy (as opposed to adopted).
     * Adopted teams are never deleted on destroy — creating a Vercel team
     * has billing side effects and deleting one is catastrophic, so destroy
     * releases adopted teams instead of deleting them.
     */
    created: boolean;
  },
  never,
  Providers
>;

type TeamAttributes = Team["Attributes"];

/**
 * A Vercel Team — the tenancy and billing boundary that owns projects,
 * domains, and storage.
 *
 * Creating a team has **billing side effects** (each team has its own plan
 * and invoices), so the common use of this resource is *adoption*: point it
 * at an existing team's `slug` (with `--adopt` / `adopt(true)`) and manage
 * the team's settings declaratively. An adopted team is never deleted on
 * destroy — only teams that alchemy itself created are deleted, and only
 * during an explicit `destroy`.
 *
 * @resource
 * @section Adopting an existing team
 * @example Manage settings of the current team
 * ```typescript
 * import { adopt } from "alchemy/AdoptPolicy";
 *
 * const team = yield* Vercel.Team("Team", {
 *   slug: "my-team",
 *   description: "Managed by alchemy",
 *   remoteCaching: { enabled: true },
 * }).pipe(adopt(true));
 * ```
 *
 * @section Creating a team
 * @example New team (billing side effects!)
 * ```typescript
 * const team = yield* Vercel.Team("Team", {
 *   slug: "my-new-team",
 *   name: "My New Team",
 * });
 * ```
 *
 * @see https://vercel.com/docs/accounts/create-a-team
 */
export const Team = Resource<Team>("Vercel.Team");

const toAttributes = (team: teams.Team, created: boolean): TeamAttributes => ({
  teamId: team.id,
  slug: team.slug,
  name: team.name,
  description: team.description,
  creatorId: team.creatorId,
  stagingPrefix: team.stagingPrefix,
  createdAt: team.createdAt,
  updatedAt: team.updatedAt,
  created,
});

const createTeamSlug = (id: string) =>
  createPhysicalName({ id, lowercase: true });

/**
 * Observe a team by id (preferred) or by slug via the authenticated user's
 * team list. Returns `undefined` when no such team is visible.
 */
const observeTeam = (teamId: string | undefined, slug: string) =>
  Effect.gen(function* () {
    if (teamId !== undefined) {
      const byId = yield* teams
        .getTeam({ teamId })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed(undefined),
          ),
        );
      if (byId !== undefined) return byId;
    }
    // Fall back to resolving the slug against the teams the token can see.
    // List rows may be `TeamLimited` (restricted membership), so re-read the
    // match by id for the authoritative settings view.
    let until: number | undefined;
    do {
      const page = yield* teams.getTeams({
        limit: 100,
        ...(until !== undefined ? { until } : {}),
      });
      const match = page.teams.find((t) => t.slug === slug);
      if (match !== undefined) {
        return yield* teams
          .getTeam({ teamId: match.id })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      }
      until = page.pagination.next ?? undefined;
    } while (until !== undefined);
    return undefined;
  });

/** Compute the settings delta between the observed team and desired props. */
const settingsDelta = (observed: teams.Team, news: TeamProps) => {
  const delta: Partial<
    Pick<
      teams.PatchTeamRequest,
      | "name"
      | "description"
      | "previewDeploymentSuffix"
      | "remoteCaching"
      | "sensitiveEnvironmentVariablePolicy"
      | "hideIpAddresses"
      | "hideIpAddressesInLogDrains"
    >
  > = {};
  if (news.name !== undefined && news.name !== (observed.name ?? undefined)) {
    delta.name = news.name;
  }
  if (
    news.description !== undefined &&
    news.description !== (observed.description ?? undefined)
  ) {
    delta.description = news.description;
  }
  if (
    news.previewDeploymentSuffix !== undefined &&
    news.previewDeploymentSuffix !==
      (observed.previewDeploymentSuffix ?? undefined)
  ) {
    delta.previewDeploymentSuffix = news.previewDeploymentSuffix;
  }
  if (
    news.remoteCaching !== undefined &&
    news.remoteCaching.enabled !== (observed.remoteCaching?.enabled ?? false)
  ) {
    delta.remoteCaching = { enabled: news.remoteCaching.enabled };
  }
  if (
    news.sensitiveEnvironmentVariablePolicy !== undefined &&
    news.sensitiveEnvironmentVariablePolicy !==
      (observed.sensitiveEnvironmentVariablePolicy ?? undefined)
  ) {
    delta.sensitiveEnvironmentVariablePolicy =
      news.sensitiveEnvironmentVariablePolicy;
  }
  if (
    news.hideIpAddresses !== undefined &&
    news.hideIpAddresses !== (observed.hideIpAddresses ?? undefined)
  ) {
    delta.hideIpAddresses = news.hideIpAddresses;
  }
  if (
    news.hideIpAddressesInLogDrains !== undefined &&
    news.hideIpAddressesInLogDrains !==
      (observed.hideIpAddressesInLogDrains ?? undefined)
  ) {
    delta.hideIpAddressesInLogDrains = news.hideIpAddressesInLogDrains;
  }
  return delta;
};

export const TeamProvider = () =>
  Provider.succeed(Team, {
    stables: ["teamId", "slug", "creatorId", "stagingPrefix", "createdAt"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      if (!output) return undefined;
      // Slugs cannot be renamed through the update API — changing the slug
      // replaces the team. Only an explicitly-set slug can drift (generated
      // slugs are stable per instance).
      if (news.slug !== undefined && news.slug !== output.slug) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const slug = output?.slug ?? olds?.slug ?? (yield* createTeamSlug(id));
      const observed = yield* observeTeam(output?.teamId, slug);
      if (observed === undefined) return undefined;
      // With prior state we know whether we created the team; without it,
      // an existing team is someone's tenancy/billing boundary — gate
      // takeover behind `--adopt`, and never mark it as alchemy-created.
      return output !== undefined
        ? toAttributes(observed, output.created)
        : Unowned(toAttributes(observed, false));
    }),
    list: Effect.fn(function* () {
      // List rows may be `TeamLimited`; re-read each by id for the full
      // shape. `created: false` — a list row carries no provenance, and
      // only rows alchemy provably created may ever be deleted.
      const rows: TeamAttributes[] = [];
      let until: number | undefined;
      do {
        const page = yield* teams.getTeams({
          limit: 100,
          ...(until !== undefined ? { until } : {}),
        });
        for (const row of page.teams) {
          const full = yield* teams
            .getTeam({ teamId: row.id })
            .pipe(
              Effect.catchTag(["NotFound", "Forbidden"], () =>
                Effect.succeed(undefined),
              ),
            );
          if (full !== undefined) rows.push(toAttributes(full, false));
        }
        until = page.pagination.next ?? undefined;
      } while (until !== undefined);
      return rows;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const slug = news.slug ?? output?.slug ?? (yield* createTeamSlug(id));

      // Observe — cloud state is authoritative; `output` only caches the
      // stable team id (and whether we created the team).
      let observed = yield* observeTeam(output?.teamId, slug);
      let created = output?.created ?? false;

      // Ensure — missing → create. NOTE: creating a Vercel team has
      // billing side effects (its own plan/invoices).
      if (observed === undefined) {
        const result = yield* teams
          .createTeam({
            slug,
            ...(news.name !== undefined ? { name: news.name } : {}),
          })
          .pipe(
            // A concurrent create of the same slug is a race — trust
            // observation and re-resolve below.
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        created = true;
        observed = yield* observeTeam(result?.id, slug);
        if (observed === undefined) {
          return yield* Effect.die(
            `Vercel team ${slug} not observable after create`,
          );
        }
      }

      // Sync — diff OBSERVED settings against desired and apply only the
      // delta. Props left undefined are unmanaged.
      const delta = settingsDelta(observed, news);
      if (Object.keys(delta).length > 0) {
        const updated = yield* teams.patchTeam({
          teamId: observed.id,
          ...delta,
        });
        return toAttributes(updated, created);
      }
      return toAttributes(observed, created);
    }),
    delete: Effect.fn(function* ({ output }) {
      // HARD SAFETY RULE: only delete teams alchemy itself created.
      // An adopted team is an entire tenancy (projects, domains, billing) —
      // destroy releases it from state without touching the cloud.
      if (!output.created) {
        yield* Effect.logInfo(
          `Vercel.Team: releasing adopted team ${output.slug} (${output.teamId}) without deleting it`,
        );
        return;
      }
      yield* teams
        .deleteTeam({ teamId: output.teamId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
