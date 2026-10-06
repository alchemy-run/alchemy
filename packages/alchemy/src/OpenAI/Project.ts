import * as OpenAI from "@distilled.cloud/openai";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { OwnedBySomeoneElse, Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

/** OpenAI data-residency configuration for a project. */
export type ProjectResidency = OpenAI.projects.PublicProjectResidency;

export interface ProjectProps {
  /**
   * Display name of the project; appears in usage reports. Mutable. If
   * omitted, a unique name is generated from the app, stage and logical ID.
   */
  name?: string;
  /**
   * Data-residency configuration. Your organization must have access to the
   * requested residency. Set at creation only; changing it replaces the
   * project.
   * @default "GLOBAL" (OpenAI's default)
   */
  residency?: ProjectResidency;
  /**
   * ID of an external (customer-managed) encryption key to associate with the
   * project. Mutable.
   */
  externalKeyId?: string;
}

export interface ProjectAttributes {
  /** The project ID (`proj_…`), used as `projectId` by other OpenAI resources. */
  projectId: string;
  /** The project's display name. */
  name: string;
  /** `active` or `archived`. */
  status: string;
  /** Data-residency configuration, when reported. */
  residency: ProjectResidency | undefined;
  /** External encryption key ID, when set. */
  externalKeyId: string | undefined;
  /** Unix timestamp (seconds) of creation. */
  createdAt: number;
}

export interface Project extends Resource<
  "OpenAI.Project",
  ProjectProps,
  ProjectAttributes,
  never,
  Providers
> {}

/**
 * An OpenAI project — the unit of isolation for API keys, service accounts,
 * rate limits, usage and billing inside an organization.
 *
 * Managed through the Admin API, so it requires an Admin key
 * (`OPENAI_ADMIN_KEY`, `sk-admin-…`); a project key alone fails with the typed
 * `MissingCredentials` error.
 *
 * OpenAI projects cannot be deleted, only archived. Destroying this resource
 * **archives** the project: it stops serving requests, its service accounts
 * and keys are revoked, and it no longer appears in the default project list,
 * but it remains visible (as archived) in the dashboard. Archival is
 * irreversible, so a later deploy creates a fresh project.
 *
 * ### Creating a Project
 * **Example:** Project with a generated name
 * ```typescript
 * const project = yield* OpenAI.Project("App");
 * ```
 *
 * **Example:** Project with an explicit name
 * ```typescript
 * const project = yield* OpenAI.Project("App", {
 *   name: "my-app-production",
 * });
 * ```
 *
 * ### Data Residency
 * **Example:** Pin the project's data to the EU
 * ```typescript
 * const project = yield* OpenAI.Project("EuApp", {
 *   residency: "EU_STORAGE_PROCESSING",
 * });
 * ```
 *
 * ### Issuing Credentials
 * **Example:** A service account with an API key for the project
 * ```typescript
 * const project = yield* OpenAI.Project("App");
 * const bot = yield* OpenAI.ServiceAccount("Bot", {
 *   projectId: project.projectId,
 * });
 * // bot.apiKey is a Redacted<string>
 * ```
 *
 * @resource
 * @product OpenAI
 * @category AI
 */
export const Project = Resource<Project>("OpenAI.Project");

type ObservedProject = OpenAI.projects.Project;

const isArchived = (project: ObservedProject) =>
  project.status === "archived" || (project.archived_at ?? null) !== null;

const toAttributes = (project: ObservedProject, fallbackName: string): ProjectAttributes => ({
  projectId: project.id,
  name: project.name ?? fallbackName,
  status: project.status ?? "active",
  residency: project.residency,
  externalKeyId: project.external_key_id ?? undefined,
  createdAt: project.created_at,
});

const projectName = (id: string, name: string | undefined) =>
  name !== undefined ? Effect.succeed(name) : createPhysicalName({ id, maxLength: 64 });

/** Fetch a live (non-archived) project by ID; archived or missing → undefined. */
const getLiveProject = (projectId: string) =>
  OpenAI.projects.getProject({ project_id: projectId }).pipe(
    Effect.map((project) => (isArchived(project) ? undefined : project)),
    Effect.catchTag("ProjectNotFound", () => Effect.succeed(undefined)),
  );

/** Active (non-archived) projects with exactly this name. */
const findProjectsByName = (name: string) =>
  OpenAI.projects.listProjects.items({ limit: 100 }).pipe(
    Stream.filter((project) => project.name === name && !isArchived(project)),
    Stream.runCollect,
    Effect.map((projects) => Array.from(projects)),
  );

export const ProjectProvider = () =>
  Provider.succeed(Project, {
    stables: ["projectId", "createdAt"],
    list: Effect.fn(function* () {
      const projects = yield* OpenAI.projects.listProjects.items({ limit: 100 }).pipe(
        Stream.filter((project) => !isArchived(project)),
        Stream.runCollect,
      );
      return Array.from(projects, (project) => toAttributes(project, project.id));
    }),
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      const oldResidency = output?.residency ?? olds?.residency;
      // Residency is create-only. Only an explicit, different value replaces —
      // an omitted value keeps whatever the project was created with.
      if (news.residency !== undefined && news.residency !== (oldResidency ?? "GLOBAL")) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      if (output?.projectId) {
        const project = yield* getLiveProject(output.projectId);
        return project ? toAttributes(project, output.name) : undefined;
      }
      // OpenAI projects carry no tags, so a name match is never proof of
      // ownership: surface it as Unowned and let the engine gate adoption.
      const name = yield* projectName(id, olds?.name);
      const [match, ...rest] = yield* findProjectsByName(name);
      if (match === undefined || rest.length > 0) return undefined;
      return Unowned(toAttributes(match, name));
    }),
    reconcile: Effect.fn(function* ({ id, news = {}, output }) {
      // 1. Observe — prefer the cached identity; archived counts as missing.
      const name = news.name ?? output?.name ?? (yield* projectName(id, undefined));
      let observed = output?.projectId ? yield* getLiveProject(output.projectId) : undefined;

      if (observed === undefined) {
        // A same-named project we have no record of is not ours to mutate.
        const [match] = yield* findProjectsByName(name);
        if (match !== undefined) {
          return yield* new OwnedBySomeoneElse({
            message: `OpenAI project "${name}" (${match.id}) already exists and requires explicit adoption`,
            resourceType: "OpenAI.Project",
            logicalId: id,
            physicalName: match.id,
          });
        }
        // 2. Ensure — projects are never deleted, so a retried create could
        // leave a duplicate behind: do not auto-retry this call.
        observed = yield* OpenAI.projects
          .createProject({
            name,
            ...(news.residency !== undefined ? { residency: news.residency } : {}),
            ...(news.externalKeyId !== undefined ? { external_key_id: news.externalKeyId } : {}),
          })
          .pipe(OpenAI.Retry.none);
      }

      // 3. Sync mutable fields against the observed project.
      const desiredKey = news.externalKeyId ?? observed.external_key_id ?? undefined;
      if (observed.name !== name || (observed.external_key_id ?? undefined) !== desiredKey) {
        observed = yield* OpenAI.projects.modifyProject({
          project_id: observed.id,
          name,
          ...(desiredKey !== undefined ? { external_key_id: desiredKey } : {}),
        });
      }

      // 4. Return the observed shape.
      return toAttributes(observed, name);
    }),
    delete: Effect.fn(function* ({ output }) {
      // Projects cannot be deleted — archive. Already archived or gone is done.
      const project = yield* getLiveProject(output.projectId);
      if (project === undefined) return;
      yield* OpenAI.projects
        .archiveProject({ project_id: output.projectId })
        .pipe(Effect.catchTag("ProjectNotFound", () => Effect.void));
    }),
  });
