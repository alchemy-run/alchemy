import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ALCHEMY_META_KEY,
  deleteProjectByIdOrName,
  ensureProject,
  makeOwnershipStamp,
  observeProject,
  readOwnershipStamp,
  readProductionUrl,
  listAllProjects,
  syncProjectEnv,
  syncProjectSettings,
  type ProjectSettingsDesired,
} from "../Deploy/Engine.ts";
import type { Providers } from "../Providers.ts";

/** Fluid compute memory tier (project-level default). */
export type MemoryTier =
  | "standard_legacy"
  | "standard"
  | "performance"
  | "performance_xl";

export type NodeVersion = "24.x" | "22.x" | "20.x" | "18.x";

export interface ProjectProps {
  /**
   * Name of the project. If omitted, a unique name is generated from
   * `${stack}-${id}-${stage}`. Changing an explicit name replaces the
   * project.
   */
  name?: string;
  /**
   * Node.js version for the project's builds and functions.
   * @default Vercel's current default (currently "22.x")
   */
  nodeVersion?: NodeVersion;
  /**
   * Default resource configuration for the project's Vercel Functions.
   */
  resources?: {
    /**
     * Fluid compute memory tier.
     * @default "standard"
     */
    memory?: MemoryTier;
    /**
     * Default max duration (seconds) for the project's functions.
     */
    maxDuration?: number;
  };
  /**
   * Default regions to deploy the project's Vercel Functions to.
   */
  regions?: string[];
}

export type Project = Resource<
  "Vercel.Project",
  ProjectProps,
  {
    projectId: string;
    projectName: string;
    /**
     * Assigned production URL, read back from the project (never computed —
     * `.vercel.app` is a global namespace). `undefined` until a production
     * alias exists.
     */
    url: string | undefined;
    nodeVersion: string;
  },
  never,
  Providers
>;

type ProjectAttributes = Project["Attributes"];

/**
 * A Vercel Project — the long-lived container that settings, env vars, and
 * domains attach to.
 *
 * You only need a standalone `Project` for **tenancy**: a project whose
 * settings you manage explicitly, with other resources renting env/domain
 * space in it (pass its id via a Function's `project:` prop). A
 * `Vercel.Function` auto-provisions and owns its own project otherwise.
 *
 * @resource
 * @section Creating a Project
 * @example Basic project
 * ```typescript
 * const project = yield* Vercel.Project("MyProject");
 * ```
 *
 * @example Project with explicit settings
 * ```typescript
 * const project = yield* Vercel.Project("MyProject", {
 *   nodeVersion: "22.x",
 *   resources: { memory: "performance" },
 *   regions: ["iad1"],
 * });
 * ```
 *
 * @section Tenancy
 * @example Renting a Function into a managed project
 * ```typescript
 * const legacy = yield* Vercel.Project("Legacy", { nodeVersion: "22.x" });
 * const fn = yield* Vercel.Function("Api", {
 *   main: "./src/api.ts",
 *   project: legacy.projectId,
 * });
 * ```
 *
 * @see https://vercel.com/docs/projects
 */
export const Project = Resource<Project>("Vercel.Project");

const desiredSettings = (props: ProjectProps): ProjectSettingsDesired => ({
  ...(props.nodeVersion !== undefined
    ? { nodeVersion: props.nodeVersion }
    : {}),
  ...(props.resources !== undefined || props.regions !== undefined
    ? {
        resourceConfig: {
          ...(props.resources?.memory !== undefined
            ? { functionDefaultMemoryType: props.resources.memory }
            : {}),
          ...(props.resources?.maxDuration !== undefined
            ? { functionDefaultTimeout: props.resources.maxDuration }
            : {}),
          ...(props.regions !== undefined
            ? { functionDefaultRegions: props.regions }
            : {}),
        },
      }
    : {}),
});

const createProjectName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return (
      name ??
      (yield* createPhysicalName({ id, maxLength: 100, lowercase: true }))
    );
  });

export const ProjectProvider = () =>
  Provider.succeed(Project, {
    stables: ["projectId"],
    diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
      if (!isResolved(news)) return undefined;
      if (!output) return undefined;
      // Engine-owned physical names: the deployed name stays authoritative
      // even if the generator would name this id differently today. Only an
      // explicit user-provided name can force a replace.
      const oldName =
        output.projectName ?? (yield* createProjectName(id, olds.name));
      const newName = news.name ?? oldName;
      if (newName !== oldName) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const idOrName =
        output?.projectId ?? (yield* createProjectName(id, olds?.name));
      const project = yield* observeProject(idOrName);
      if (project === undefined) return undefined;
      const attrs: ProjectAttributes = {
        projectId: project.id,
        projectName: project.name,
        url: readProductionUrl(project),
        nodeVersion: project.nodeVersion,
      };
      const stamp = yield* readOwnershipStamp(project.id);
      const expected = yield* makeOwnershipStamp(id);
      return stamp !== undefined &&
        stamp.stack === expected.stack &&
        stamp.stage === expected.stage &&
        stamp.logicalId === expected.logicalId
        ? attrs
        : Unowned(attrs);
    }),
    list: Effect.fn(function* () {
      const summaries = yield* listAllProjects();
      const rows = yield* Effect.forEach(
        summaries,
        (summary) =>
          Effect.gen(function* () {
            const project = yield* observeProject(summary.id);
            if (project === undefined) return undefined;
            // Only surface alchemy-stamped projects — Vercel has no tags,
            // so the env stamp is the ownership signal.
            const stamp = yield* readOwnershipStamp(project.id);
            if (stamp === undefined) return undefined;
            return {
              projectId: project.id,
              projectName: project.name,
              url: readProductionUrl(project),
              // Generated enum widened to the attrs' plain string.
              nodeVersion: project.nodeVersion as string,
            } satisfies ProjectAttributes;
          }),
        { concurrency: 8 },
      );
      return rows.filter((row): row is ProjectAttributes => row !== undefined);
    }),
    reconcile: Effect.fn(function* ({ id, news = {}, output }) {
      // Observe + ensure — prefer the deployed name (engine-owned physical
      // names); an explicit name change arrives as a replacement instance
      // with no output.
      const name =
        output?.projectName ?? (yield* createProjectName(id, news.name));
      const desired = desiredSettings(news);
      const project = yield* ensureProject({ name, desired });

      // Sync mutable settings by observed-vs-desired delta.
      yield* syncProjectSettings({ project, desired });

      // Ownership stamp (DESIGN §5.4) — the primary read/adoption signal.
      const stamp = yield* makeOwnershipStamp(id);
      yield* syncProjectEnv({
        idOrName: project.id,
        desired: [
          {
            key: ALCHEMY_META_KEY,
            value: JSON.stringify(stamp),
            type: "plain",
          },
        ],
        // The stamp is a `plain` (observable) row, so a constant baseline
        // suffices — nothing sensitive to persist.
        managedEnv: [{ key: ALCHEMY_META_KEY, type: "plain" }],
      });

      // Return fresh attributes (URL read back, never computed).
      const fresh = yield* observeProject(project.id);
      const observed = fresh ?? project;
      return {
        projectId: observed.id,
        projectName: observed.name,
        url: readProductionUrl(observed),
        nodeVersion: observed.nodeVersion,
      } satisfies ProjectAttributes;
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* deleteProjectByIdOrName(output.projectId);
    }),
  });
