import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import type { Secret } from "../secret.ts";
import { logger } from "../util/logger.ts";
import { SentryApi } from "./api.ts";

/**
 * Properties for creating or updating a Team
 */
export interface TeamProps {
  /**
   * The name for the team
   *
   * @default ${app}-${stage}-${id}
   */
  name?: string;

  /**
   * Uniquely identifies a team and is used for the interface
   */
  slug?: string;

  /**
   * The organization ID or slug that owns the team
   */
  organization: string;

  /**
   * Auth token to use (overrides environment variable)
   */
  authToken?: Secret;

  /**
   * Whether to adopt an existing team with the same slug if it exists
   * If true and a team with the same slug exists, it will be adopted rather than creating a new one
   *
   * @default false
   */
  adopt?: boolean;
}

/**
 * Output returned after Team creation/update
 */
export interface Team extends Resource<"sentry::Team">, TeamProps {
  /**
   * The ID of the team
   */
  id: string;

  /**
   * Name of the Team.
   */
  name: string;

  /**
   * Time at which the team was created
   */
  dateCreated: string;

  /**
   * Whether the current user is a member of the team
   */
  isMember: boolean;

  /**
   * The role of the current user in the team
   */
  teamRole: string;

  /**
   * Team flags
   */
  flags: {
    "idp:provisioned": boolean;
  };

  /**
   * Access permissions for the team
   */
  access: string[];

  /**
   * Whether the current user has access to the team
   */
  hasAccess: boolean;

  /**
   * Whether the team membership is pending
   */
  isPending: boolean;

  /**
   * Number of members in the team
   */
  memberCount: number;

  /**
   * Team avatar information
   */
  avatar: {
    avatarType: string;
    avatarUuid: string | null;
  };
}

/**
 * Create and manage Sentry teams
 *
 * @example
 * // Create a basic Sentry team:
 * const team = await Team("my-team", {
 *   name: "My Team",
 *   organization: "my-org"
 * });
 *
 * @example
 * // Create a team with a custom slug:
 * const team = await Team("custom-team", {
 *   name: "Custom Team",
 *   organization: "my-org",
 *   slug: "custom-team-slug"
 * });
 *
 * @example
 * // Create or adopt an existing team with the same slug:
 * const team = await Team("existing-team", {
 *   name: "Existing Team",
 *   organization: "my-org",
 *   adopt: true
 * });
 */
export const Team = Resource(
  "sentry::Team",
  async function (
    this: Context<Team>,
    id: string,
    props: TeamProps,
  ): Promise<Team> {
    const api = new SentryApi({ authToken: props.authToken });

    // it's possible that `this.output.name` is undefined because a previous version
    // of alchemy had a bug where it didn't set the name on the output
    // so, we try to find the key by ID and use the name from the API response
    const lookupName = async () => {
      if (!this.output) {
        return undefined;
      } else if (this.output?.name) {
        return this.output.name;
      }
      const name = await getTeamName(api, props.organization, this.output.id);
      if (name) {
        this.output.name = name;
      }
      return name;
    };

    const teamName =
      props.name ?? (await lookupName()) ?? this.scope.createPhysicalName(id);

    if (this.phase === "update" && this.output.name !== teamName) {
      // TODO(sam): can we rename without destroying?
      // -> no: https://docs.sentry.io/api/teams/update-a-team/
      this.replace();
    }

    if (this.phase === "delete") {
      try {
        if (this.output?.id) {
          const response = await api.delete(
            `/teams/${props.organization}/${this.output.slug || this.output.id}/`,
          );
          if (!response.ok && response.status !== 404) {
            logger.error("Error deleting team:", response.statusText);
          }
        }
      } catch (error) {
        logger.error("Error deleting team:", error);
      }
      return this.destroy();
    } else {
      try {
        let response;

        if (this.phase === "update" && this.output?.id) {
          response = await api.put(
            `/teams/${props.organization}/${this.output.slug || this.output.id}/`,
            props,
          );
        } else {
          try {
            response = await api.post(
              `/organizations/${props.organization}/teams/`,
              props,
            );
          } catch (error) {
            // Check if this is a "team already exists" error and adopt is enabled
            if (
              (props.adopt ?? this.scope.adopt) &&
              error instanceof Error &&
              error.message.includes("already exists")
            ) {
              logger.log(
                `Team '${props.slug || teamName}' already exists, adopting it`,
              );
              // Find the existing team by slug
              const existingTeam = await findTeamBySlug(
                api,
                props.organization,
                props.slug || teamName,
              );
              if (!existingTeam) {
                throw new Error(
                  `Failed to find existing team '${props.slug || teamName}' for adoption`,
                );
              }
              response = await api.get(
                `/organizations/${props.organization}/teams/${existingTeam.slug}/`,
              );
            } else {
              throw error;
            }
          }
        }

        if (!response.ok) {
          throw new Error(
            `API error: ${response.statusText} ${await response.text()}`,
          );
        }

        const data = (await response.json()) as Omit<Team, keyof TeamProps>;
        return this({
          ...props,
          id: data.id,
          name: teamName,
          dateCreated: data.dateCreated,
          isMember: data.isMember,
          teamRole: data.teamRole,
          flags: data.flags,
          access: data.access,
          hasAccess: data.hasAccess,
          isPending: data.isPending,
          memberCount: data.memberCount,
          avatar: data.avatar,
        });
      } catch (error) {
        logger.error("Error creating/updating team:", error);
        throw error;
      }
    }
  },
);

/**
 * Find a team by slug
 */
async function findTeamBySlug(
  api: SentryApi,
  organization: string,
  slug: string,
): Promise<{ id: string; slug: string } | null> {
  const response = await api.get(`/teams/${organization}/${slug}/`);
  if (!response.ok) {
    throw new Error(`API error: ${response.statusText}`);
  }

  const teams = (await response.json()) as Array<{ id: string; slug: string }>;
  const team = teams.find((t) => t.slug === slug);
  return team ? { id: team.id, slug: team.slug } : null;
}

async function getTeamName(
  api: SentryApi,
  organization: string,
  slug: string,
): Promise<string | undefined> {
  const response = await api.get(`/teams/${organization}/${slug}/`);
  if (!response.ok) {
    throw new Error(`API error: ${response.statusText}`);
  }

  return ((await response.json()) as { name: string }).name;
}
