import * as DO from "@distilled.cloud/digitalocean";
import type { Project as ApiProject, ProjectEnvironment } from "@distilled.cloud/digitalocean";
import { Unowned } from "alchemy/AdoptPolicy";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ignoreNotFound, noneIfNotFound } from "./internal/notFound.ts";
import { pollUntil, type PollBudget } from "./internal/poll.ts";
import type { Providers } from "./Providers.ts";

export type { ProjectEnvironment } from "@distilled.cloud/digitalocean";

export type ProjectProps = {
  /**
   * Project name, unique within the team, at most 175 characters. A change
   * renames the project in place.
   *
   * @default a generated physical name
   */
  name?: string;
  /** Free-form description, at most 255 characters. */
  description?: string;
  /**
   * What the project is for, for example `"Web Application"` or
   * `"Service or API"`.
   *
   * @default "Web Application"
   */
  purpose?: string;
  /** Deployment environment the project's resources belong to. */
  environment?: ProjectEnvironment;
};

export type Project = Resource<
  "DigitalOcean.Project",
  ProjectProps,
  {
    /** Project id (UUID). */
    projectId: string;
    /** Project name. */
    name: string;
    /** Description, when one is set. */
    description: string | undefined;
    /** What the project is for. */
    purpose: string;
    /** Deployment environment, when one is set. */
    environment: ProjectEnvironment | undefined;
    /** Whether this is the team's default project. */
    isDefault: boolean;
    /** ISO 8601 creation time. */
    createdAt: string;
  },
  never,
  Providers
>;

export type ProjectAttributes = Project["Attributes"];

/**
 * A DigitalOcean Project: a folder that groups droplets, volumes,
 * databases, domains and other resources in the control panel. Every
 * resource belongs to one project; until you move it, that is the team's
 * default project. Move resources into a project with `ProjectResources`.
 * Every prop updates in place.
 *
 * Alchemy owns a project whose name it generated or whose id it recorded.
 * A project that already has the chosen name is `Unowned` and needs
 * `--adopt`. A project must be empty to be deleted.
 *
 * ### Creating a Project
 * **Example:** A production project
 * ```typescript
 * const project = yield* DigitalOcean.Project("shop", {
 *   name: "shop",
 *   purpose: "Web Application",
 *   environment: "Production",
 * });
 * ```
 *
 * ### Grouping Resources
 * **Example:** Move a droplet and a volume into the project
 * ```typescript
 * const project = yield* DigitalOcean.Project("shop", { environment: "Production" });
 * const host = yield* DigitalOcean.Droplet("app", {
 *   region: "sfo3",
 *   size: "s-1vcpu-1gb",
 *   image: "ubuntu-24-04-x64",
 * });
 * const data = yield* DigitalOcean.Volume("data", { region: "sfo3", sizeGigabytes: 10 });
 * yield* DigitalOcean.ProjectResources("shop-resources", {
 *   projectId: project.projectId,
 *   resources: [host.urn, data.urn],
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Projects
 *
 * @resource
 * @product Projects
 * @category Management
 */
export const Project = Resource<Project>("DigitalOcean.Project");

export class ProjectWaitTimedOut extends Data.TaggedError("DigitalOcean.ProjectWaitTimedOut")<{
  readonly projectId: string;
  readonly waitingFor: string;
}> {
  override get message() {
    return `Project ${this.projectId} timed out waiting for ${this.waitingFor}.`;
  }
}

const NAME_MAX_LENGTH = 175;

const PAGE_SIZE = 200;

const DEFAULT_PURPOSE = "Web Application";

// GET lags a change by a few seconds.
const PROJECT_POLL: PollBudget = { maxDelay: "3 seconds", times: 20 };

const toAttrs = (project: ApiProject): ProjectAttributes => ({
  projectId: project.id,
  name: project.name,
  description: project.description || undefined,
  purpose: project.purpose,
  environment: project.environment || undefined,
  isDefault: project.is_default,
  createdAt: project.created_at,
});

const physicalName = (id: string) => createPhysicalName({ id, maxLength: NAME_MAX_LENGTH });

const observeById = (projectId: string) =>
  noneIfNotFound(DO.getProject({ project_id: projectId }).pipe(Effect.map((r) => r.project)));

const observeByName = (name: string) =>
  DO.listProjects.items({ per_page: PAGE_SIZE }).pipe(
    Stream.filter((project) => project.name === name),
    Stream.runHead,
  );

const observeOwned = Effect.fn(function* (
  projectId: string | undefined,
  generatedName: string | undefined,
) {
  if (projectId !== undefined) {
    const byId = yield* observeById(projectId);
    if (Option.isSome(byId)) return byId;
  }
  if (generatedName === undefined) return Option.none<ApiProject>();
  return yield* observeByName(generatedName);
});

const isInSync = (project: ApiProject, name: string, news: ProjectProps) =>
  project.name === name &&
  (project.description ?? "") === (news.description ?? "") &&
  project.purpose === (news.purpose ?? DEFAULT_PURPOSE) &&
  (news.environment === undefined || project.environment === news.environment);

const waitUntilGone = (projectId: string) =>
  pollUntil(observeById(projectId), {
    ...PROJECT_POLL,
    until: Option.isNone,
    onTimeout: () => new ProjectWaitTimedOut({ projectId, waitingFor: "deletion" }),
  });

export const ProjectProvider = () =>
  Provider.succeed(Project, {
    stables: ["projectId", "createdAt"],
    // A project carries no ownership marker.
    nuke: { skip: true },
    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const generatedName = olds.name === undefined ? yield* physicalName(id) : undefined;
      const owned = yield* observeOwned(output?.projectId, generatedName);
      if (Option.isSome(owned)) return toAttrs(owned.value);
      if (olds.name === undefined) return undefined;
      const named = yield* observeByName(olds.name);
      return named.pipe(
        Option.map((project) =>
          project.id === previous?.projectId ? toAttrs(project) : Unowned(toAttrs(project)),
        ),
        Option.getOrUndefined,
      );
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = news.name ?? (yield* physicalName(id));
      const generatedName = news.name === undefined ? name : undefined;

      const observed = yield* observeOwned(output?.projectId, generatedName);
      const project = yield* Option.match(observed, {
        onNone: () =>
          DO.createProject({
            name,
            description: news.description,
            purpose: news.purpose ?? DEFAULT_PURPOSE,
            environment: news.environment,
          }).pipe(Effect.map((response) => response.project)),
        onSome: Effect.succeed,
      });
      if (isInSync(project, name, news)) return toAttrs(project);
      const patched = yield* DO.patchProject({
        project_id: project.id,
        name,
        description: news.description ?? "",
        purpose: news.purpose ?? DEFAULT_PURPOSE,
        environment: news.environment,
      });
      return toAttrs(patched.project);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteProject({ project_id: output.projectId }));
      yield* waitUntilGone(output.projectId);
    }),
  });
