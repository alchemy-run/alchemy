import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import type { Secret } from "../secret.ts";
import { logger } from "../util/logger.ts";
import { SentryApi } from "./api.ts";

/**
 * Properties for creating or updating a Project
 */
export interface ProjectProps {
  /**
   * The name for the project
   *
   * @default ${app}-${stage}-${id}
   */
  name?: string;

  /**
   * Uniquely identifies a project and is used for the interface
   */
  slug?: string;

  /**
   * The platform for the project
   */
  platform?: string;

  /**
   * Whether to alert on every new issue
   */
  defaultRules?: boolean;

  /**
   * The team slug that owns the project
   */
  team: string;

  /**
   * The organization ID or slug that owns the project
   */
  organization: string;

  /**
   * Auth token to use (overrides environment variable)
   */
  authToken?: Secret;

  /**
   * Whether to adopt an existing project with the same slug if it exists
   * If true and a project with the same slug exists, it will be adopted rather than creating a new one
   *
   * @default false
   */
  adopt?: boolean;
}

/**
 * Output returned after Project creation/update
 */
export interface Project extends Omit<ProjectProps, "team"> {
  /**
   * The ID of the project
   */
  id: string;

  /**
   * The name for the project
   */
  name: string;

  /**
   * The team that owns the project
   */
  team: {
    id: string;
    name: string;
    slug: string;
  };

  /**
   * All teams that have access to the project
   */
  teams: Array<{
    id: string;
    name: string;
    slug: string;
  }>;

  /**
   * Whether the project is bookmarked
   */
  isBookmarked: boolean;

  /**
   * Whether the current user is a member of the project
   */
  isMember: boolean;

  /**
   * Access permissions for the project
   */
  access: string[];

  /**
   * Whether the current user has access to the project
   */
  hasAccess: boolean;

  /**
   * Time at which the project was created
   */
  dateCreated: string;

  /**
   * List of environments in the project
   */
  environments: string[];

  /**
   * Event processing status
   */
  eventProcessing: {
    symbolicationDegraded: boolean;
  };

  /**
   * List of features enabled for the project
   */
  features: string[];

  /**
   * Whether the project has received its first event
   */
  firstEvent: string | null;

  /**
   * Whether the project has received its first transaction event
   */
  firstTransactionEvent: boolean;

  /**
   * Whether the project has sessions
   */
  hasSessions: boolean;

  /**
   * Whether the project has profiles
   */
  hasProfiles: boolean;

  /**
   * Whether the project has replays
   */
  hasReplays: boolean;

  /**
   * Whether the project has flags
   */
  hasFlags: boolean;

  /**
   * Whether the project has monitors
   */
  hasMonitors: boolean;

  /**
   * Whether the project has feedback
   */
  hasFeedbacks: boolean;

  /**
   * Whether the project has new feedback
   */
  hasNewFeedbacks: boolean;

  /**
   * Whether the project has minified stack traces
   */
  hasMinifiedStackTrace: boolean;

  /**
   * Whether the project has HTTP insights
   */
  hasInsightsHttp: boolean;

  /**
   * Whether the project has database insights
   */
  hasInsightsDb: boolean;

  /**
   * Whether the project has asset insights
   */
  hasInsightsAssets: boolean;

  /**
   * Whether the project has app start insights
   */
  hasInsightsAppStart: boolean;

  /**
   * Whether the project has screen load insights
   */
  hasInsightsScreenLoad: boolean;

  /**
   * Whether the project has vitals insights
   */
  hasInsightsVitals: boolean;

  /**
   * Whether the project has cache insights
   */
  hasInsightsCaches: boolean;

  /**
   * Whether the project has queue insights
   */
  hasInsightsQueues: boolean;

  /**
   * Whether the project has LLM monitoring
   */
  hasInsightsLlmMonitoring: boolean;

  /**
   * List of platforms in the project
   */
  platforms: string[];

  /**
   * Latest release information
   */
  latestRelease: string | null;

  /**
   * Whether the project has user reports
   */
  hasUserReports: boolean;

  /**
   * Latest deployment information
   */
  latestDeploys: string | null;
}

/**
 * Create and manage Sentry projects
 *
 * @example
 * // Create a basic Sentry project:
 * const project = await Project("my-project", {
 *   name: "My Project",
 *   team: "my-team",
 *   organization: "my-org"
 * });
 *
 * @example
 * // Create a project for a specific platform:
 * const project = await Project("js-project", {
 *   name: "JavaScript Project",
 *   team: "my-team",
 *   organization: "my-org",
 *   platform: "javascript"
 * });
 *
 * @example
 * // Create a project with a custom slug and disabled default rules:
 * const project = await Project("custom-project", {
 *   name: "Custom Project",
 *   team: "my-team",
 *   organization: "my-org",
 *   slug: "custom-project-slug",
 *   defaultRules: false
 * });
 *
 * @example
 * // Create or adopt an existing project with the same slug:
 * const project = await Project("existing-project", {
 *   name: "Existing Project",
 *   team: "my-team",
 *   organization: "my-org",
 *   adopt: true
 * });
 */
export const Project = Resource(
  "sentry::Project",
  async function (
    this: Context<Project>,
    id: string,
    props: ProjectProps,
  ): Promise<Project> {
    const api = new SentryApi({ authToken: props.authToken });

    // it's possible that `this.output.name` is undefined because a previous version
    // of alchemy had a bug where it didn't set the name on the output
    // so, we try to find the key by ID and use the name from the API response
    const lookupName = async () => {
      if (!this.output) {
        return undefined;
      } else if (this.output.name) {
        return this.output.name;
      }
      const name = await getProjectName(
        api,
        props.organization,
        this.output.id,
      );
      if (name) {
        this.output.name = name;
      }
      return name;
    };

    const projectName =
      props.name ?? (await lookupName()) ?? this.scope.createPhysicalName(id);

    if (this.phase === "update" && this.output.name !== projectName) {
      await api.put(
        `/projects/${props.organization}/${this.output.slug || this.output.id}/`,
        {
          name: projectName,
        },
      );
    }

    if (this.phase === "delete") {
      try {
        if (this.output?.id) {
          const response = await api.delete(
            `/projects/${props.organization}/${this.output.slug || this.output.id}/`,
          );
          if (!response.ok && response.status !== 404) {
            logger.error("Error deleting project:", response.statusText);
          }
        }
      } catch (error) {
        logger.error("Error deleting project:", error);
      }
      return this.destroy();
    } else {
      try {
        let response;

        if (this.phase === "update" && this.output?.id) {
          response = await api.put(
            `/projects/${props.organization}/${this.output.slug || this.output.id}/`,
            props,
          );
        } else {
          try {
            response = await api.post(
              `/teams/${props.organization}/${props.team}/projects/`,
              props,
            );
          } catch (error) {
            // Check if this is a "project already exists" error and adopt is enabled
            if (
              (props.adopt ?? this.scope.adopt) &&
              error instanceof Error &&
              error.message.includes("already exists")
            ) {
              logger.log(
                `Project '${props.slug || projectName}' already exists, adopting it`,
              );
              // Find the existing project by slug
              const existingProject = await findProjectBySlug(
                api,
                props.organization,
                props.slug || projectName,
              );
              if (!existingProject) {
                throw new Error(
                  `Failed to find existing project '${props.slug || projectName}' for adoption`,
                );
              }
              response = await api.get(
                `/projects/${props.organization}/${existingProject.slug}/`,
              );
            } else {
              throw error;
            }
          }
        }

        if (!response.ok) {
          throw new Error(`API error: ${await response.text()}`);
        }

        const data = (await response.json()) as Omit<
          Project,
          keyof ProjectProps
        > & { team: Project["team"] };
        return {
          ...props,
          id: data.id,
          name: projectName,
          team: data.team,
          teams: data.teams,
          isBookmarked: data.isBookmarked,
          isMember: data.isMember,
          access: data.access,
          hasAccess: data.hasAccess,
          dateCreated: data.dateCreated,
          environments: data.environments,
          eventProcessing: data.eventProcessing,
          features: data.features,
          firstEvent: data.firstEvent,
          firstTransactionEvent: data.firstTransactionEvent,
          hasSessions: data.hasSessions,
          hasProfiles: data.hasProfiles,
          hasReplays: data.hasReplays,
          hasFlags: data.hasFlags,
          hasMonitors: data.hasMonitors,
          hasFeedbacks: data.hasFeedbacks,
          hasNewFeedbacks: data.hasNewFeedbacks,
          hasMinifiedStackTrace: data.hasMinifiedStackTrace,
          hasInsightsHttp: data.hasInsightsHttp,
          hasInsightsDb: data.hasInsightsDb,
          hasInsightsAssets: data.hasInsightsAssets,
          hasInsightsAppStart: data.hasInsightsAppStart,
          hasInsightsScreenLoad: data.hasInsightsScreenLoad,
          hasInsightsVitals: data.hasInsightsVitals,
          hasInsightsCaches: data.hasInsightsCaches,
          hasInsightsQueues: data.hasInsightsQueues,
          hasInsightsLlmMonitoring: data.hasInsightsLlmMonitoring,
          platforms: data.platforms,
          latestRelease: data.latestRelease,
          hasUserReports: data.hasUserReports,
          latestDeploys: data.latestDeploys,
        } satisfies Project;
      } catch (error) {
        logger.error("Error creating/updating project:", error);
        throw error;
      }
    }
  },
);

/**
 * Find a project by slug
 */
async function findProjectBySlug(
  api: SentryApi,
  organization: string,
  slug: string,
): Promise<{ id: string; slug: string } | null> {
  const response = await api.get(`/projects/${organization}`);
  if (!response.ok) {
    throw new Error(`API error: ${response.statusText}`);
  }

  const projects = (await response.json()) as Array<{
    id: string;
    slug: string;
  }>;
  const project = projects.find((p) => p.slug === slug);
  return project ? { id: project.id, slug: project.slug } : null;
}

async function getProjectName(
  api: SentryApi,
  organization: string,
  slug: string,
): Promise<string | undefined> {
  const response = await api.get(`/projects/${organization}/${slug}/`);
  if (!response.ok) {
    throw new Error(`API error: ${response.statusText}`);
  }

  return ((await response.json()) as { name: string }).name;
}
