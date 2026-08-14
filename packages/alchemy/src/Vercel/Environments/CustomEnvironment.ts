import {
  createCustomEnvironment,
  getCustomEnvironment,
  getProjectsByIdOrNameCustomEnvironments,
  removeCustomEnvironment,
  updateCustomEnvironment,
} from "@distilled.cloud/vercel/environment";
import { getProjects } from "@distilled.cloud/vercel/projects";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { VercelEnvironment } from "../VercelEnvironment.ts";

/**
 * A reference to the Vercel project the custom environment lives in: a
 * project id (`prj_…`), a project name, or any resource carrying a
 * `projectId` attribute (e.g. `Vercel.Project`).
 */
export type CustomEnvironmentProjectSource = string | { projectId: string };

/** How a git branch is matched to the custom environment. */
export interface BranchMatcher {
  /** Matching mode applied to `pattern`. */
  type: "equals" | "startsWith" | "endsWith";
  /** Git branch name or portion thereof. */
  pattern: string;
}

export interface CustomEnvironmentProps {
  /**
   * The project to create the custom environment in. Accepts a
   * `Vercel.Project` resource, a project id (`prj_…`), or a project name.
   *
   * Changing the project replaces the environment.
   */
  project: CustomEnvironmentProjectSource;
  /**
   * URL-friendly name of the environment (lowercase letters, digits and
   * hyphens, at most 32 characters; must not be `production` or `preview`).
   * If omitted, a unique slug is generated from the stack, stage, and
   * logical id. An explicit slug change renames the environment in place.
   */
  slug?: string;
  /**
   * Human-readable description of the environment's purpose.
   */
  description?: string;
  /**
   * Automatically attach deployments of matching git branches to this
   * environment. Omit to leave branch matching unconfigured.
   */
  branchMatcher?: BranchMatcher;
  /**
   * Custom environment id or slug to copy environment variables from at
   * creation time. Only applied when the environment is first created.
   */
  copyEnvVarsFrom?: string;
  /**
   * Whether deleting this environment also deletes environment variables
   * that would no longer be assigned to any environment.
   *
   * @default false
   */
  deleteUnassignedEnvironmentVariables?: boolean;
}

export type CustomEnvironment = Resource<
  "Vercel.CustomEnvironment",
  CustomEnvironmentProps,
  {
    /** The custom environment id (`env_…`). Changes on replacement. */
    environmentId: string;
    /** URL-friendly name of the environment. */
    slug: string;
    /**
     * The project reference the environment was created under — the resolved
     * project id when a `Vercel.Project` (or id) was given, otherwise the
     * project name as passed. Used as `idOrName` on subsequent API calls.
     */
    projectId: string;
    /** Environment class as reported by Vercel (custom envs are `preview`). */
    type: "development" | "preview" | "production";
    /** The environment's description, if any. */
    description: string | undefined;
    /** The configured branch matcher, if any. */
    branchMatcher: BranchMatcher | undefined;
    /** Creation time in epoch milliseconds. */
    createdAt: number;
    /** Last update time in epoch milliseconds. */
    updatedAt: number;
  },
  never,
  Providers
>;

type CustomEnvironmentAttributes = CustomEnvironment["Attributes"];

/**
 * A Vercel custom environment: a named, pre-production environment of a
 * project beyond the built-in `production`/`preview`/`development` — e.g. a
 * long-lived `staging` with its own env-var scope, domains, and branch
 * matching.
 *
 * Plan limits apply: Pro teams get 1 custom environment per project
 * (Enterprise more). Exceeding the limit fails the deploy with a typed
 * `BadRequest` ("Cannot create more than 1 custom environments.").
 *
 * @resource
 * @section Creating a custom environment
 * @example Auto-named environment
 * ```typescript
 * const project = yield* Vercel.Project("my-app", {});
 * const env = yield* Vercel.CustomEnvironment("Staging", { project });
 * ```
 *
 * @example Explicit slug and description
 * ```typescript
 * const env = yield* Vercel.CustomEnvironment("Staging", {
 *   project,
 *   slug: "staging",
 *   description: "Pre-production environment",
 * });
 * ```
 *
 * @section Branch matching
 * @example Attach deployments of release branches
 * ```typescript
 * const env = yield* Vercel.CustomEnvironment("Staging", {
 *   project,
 *   slug: "staging",
 *   branchMatcher: { type: "startsWith", pattern: "release/" },
 * });
 * ```
 *
 * @section Copying environment variables
 * @example Seed the environment from another one
 * ```typescript
 * const env = yield* Vercel.CustomEnvironment("Staging", {
 *   project,
 *   slug: "staging",
 *   copyEnvVarsFrom: "production",
 * });
 * ```
 *
 * @see https://vercel.com/docs/deployments/custom-environments
 */
export const CustomEnvironment = Resource<CustomEnvironment>(
  "Vercel.CustomEnvironment",
);

const teamScope = Effect.gen(function* () {
  const { teamId } = yield* VercelEnvironment.current;
  return teamId !== undefined ? { teamId } : {};
});

const resolveProjectRef = (
  source: CustomEnvironmentProjectSource,
): string | undefined => {
  if (typeof source === "string") return source;
  if (source && "projectId" in source && source.projectId) {
    return source.projectId as unknown as string;
  }
  return undefined;
};

/** Custom environment slugs must be lowercase and at most 32 characters. */
const createSlug = (id: string, slug: string | undefined) =>
  Effect.gen(function* () {
    return (
      slug ??
      (yield* createPhysicalName({ id, maxLength: 32, lowercase: true }))
    );
  });

const sameBranchMatcher = (
  a: BranchMatcher | undefined,
  b: BranchMatcher | undefined,
): boolean =>
  a === undefined || b === undefined
    ? a === b
    : a.type === b.type && a.pattern === b.pattern;

/**
 * Structural shape shared by every custom-environment response (get, create,
 * update, list item) — the generated types are per-operation but identical
 * in the fields we read.
 */
interface CustomEnvironmentShape {
  readonly id: string;
  readonly slug: string;
  readonly type: "development" | "preview" | "production";
  readonly description?: string;
  readonly branchMatcher?: {
    readonly type: "equals" | "startsWith" | "endsWith";
    readonly pattern: string;
  };
  readonly createdAt: number;
  readonly updatedAt: number;
}

const toAttributes = (
  env: CustomEnvironmentShape,
  projectRef: string,
): CustomEnvironmentAttributes => ({
  environmentId: env.id,
  slug: env.slug,
  projectId: projectRef,
  type: env.type,
  description: env.description,
  branchMatcher: env.branchMatcher
    ? { type: env.branchMatcher.type, pattern: env.branchMatcher.pattern }
    : undefined,
  createdAt: env.createdAt,
  updatedAt: env.updatedAt,
});

export const CustomEnvironmentProvider = () =>
  Provider.succeed(CustomEnvironment, {
    stables: ["environmentId", "projectId", "type", "createdAt"],
    diff: Effect.fn(function* ({ id, olds, news, output }) {
      // A changed project re-homes the environment — always a replacement.
      // `projectId` is a stable attribute of `Vercel.Project`, so the plan
      // resolves `news.project` to a plain object carrying it even while the
      // project itself is being updated in place.
      const oldProjectRef =
        output?.projectId ??
        (olds.project !== undefined
          ? resolveProjectRef(olds.project as CustomEnvironmentProjectSource)
          : undefined);
      const newProjectRef =
        "project" in news
          ? resolveProjectRef(news.project as CustomEnvironmentProjectSource)
          : undefined;
      if (oldProjectRef !== undefined && oldProjectRef !== newProjectRef) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      // Auto-generated slugs are engine-owned: the deployed slug stays
      // authoritative even if the generator would name this id differently
      // today. Only an explicit `slug` prop can force a rename.
      const oldSlug = output?.slug ?? (yield* createSlug(id, olds.slug));
      const newSlug = news.slug ?? oldSlug;
      if (
        newSlug !== oldSlug ||
        (news.description ?? undefined) !==
          (output?.description ?? undefined) ||
        !sameBranchMatcher(news.branchMatcher, output?.branchMatcher)
      ) {
        return { action: "update" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const team = yield* teamScope;
      if (output?.environmentId) {
        return yield* getCustomEnvironment({
          idOrName: output.projectId,
          environmentSlugOrId: output.environmentId,
          ...team,
        }).pipe(
          Effect.map((env) => toAttributes(env, output.projectId)),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      }
      // State-loss recovery: derive the deterministic slug and look it up in
      // the project from the prior props (custom environments carry no
      // metadata to stamp, so identity is deterministic naming + state,
      // DESIGN §5.4).
      if (!olds?.project) return undefined;
      const projectRef = resolveProjectRef(
        olds.project as CustomEnvironmentProjectSource,
      );
      if (projectRef === undefined) return undefined;
      const slug = yield* createSlug(id, olds.slug);
      return yield* getCustomEnvironment({
        idOrName: projectRef,
        environmentSlugOrId: slug,
        ...team,
      }).pipe(
        Effect.map((env) => toAttributes(env, projectRef)),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const team = yield* teamScope;
      const projectRef =
        output?.projectId ??
        resolveProjectRef(news.project as CustomEnvironmentProjectSource);
      if (projectRef === undefined) {
        return yield* Effect.die(
          "Invalid Vercel project source: must be a Project, a project id, or a project name",
        );
      }
      // Prefer the deployed slug: regenerating would target a different
      // environment if the generator's output for this id ever drifts. An
      // explicit `news.slug` still renames the environment in place.
      const desiredSlug =
        news.slug ?? output?.slug ?? (yield* createSlug(id, news.slug));

      // Observe — the persisted id is a cache, not proof of existence; with
      // no id (greenfield or a crashed run that never persisted state) the
      // deterministic slug is the lookup key.
      const observed = yield* getCustomEnvironment({
        idOrName: projectRef,
        environmentSlugOrId: output?.environmentId ?? desiredSlug,
        ...team,
      }).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

      // Ensure — missing → create.
      const existing =
        observed ??
        (yield* createCustomEnvironment({
          idOrName: projectRef,
          slug: desiredSlug,
          description: news.description,
          branchMatcher: news.branchMatcher,
          copyEnvVarsFrom: news.copyEnvVarsFrom,
          ...team,
        }));

      // Sync — diff observed cloud state against desired and PATCH only the
      // delta. `branchMatcher: null` clears an existing matcher; a
      // description is cleared by writing the empty string (the API treats
      // an omitted field as "leave unchanged").
      const desiredDescription = news.description ?? undefined;
      const observedDescription =
        existing.description === "" ? undefined : existing.description;
      const slugDelta = existing.slug !== desiredSlug;
      const descriptionDelta = observedDescription !== desiredDescription;
      const matcherDelta = !sameBranchMatcher(
        existing.branchMatcher
          ? {
              type: existing.branchMatcher.type,
              pattern: existing.branchMatcher.pattern,
            }
          : undefined,
        news.branchMatcher,
      );
      if (slugDelta || descriptionDelta || matcherDelta) {
        const updated = yield* updateCustomEnvironment({
          idOrName: projectRef,
          environmentSlugOrId: existing.id,
          ...(slugDelta ? { slug: desiredSlug } : {}),
          ...(descriptionDelta
            ? { description: desiredDescription ?? "" }
            : {}),
          ...(matcherDelta
            ? { branchMatcher: news.branchMatcher ?? null }
            : {}),
          ...team,
        });
        return toAttributes(updated, projectRef);
      }
      return toAttributes(existing, projectRef);
    }),
    delete: Effect.fn(function* ({ olds, output }) {
      const team = yield* teamScope;
      yield* removeCustomEnvironment({
        idOrName: output.projectId,
        environmentSlugOrId: output.environmentId,
        // Always sent explicitly: the endpoint requires a JSON body (an
        // empty request answers 400 "Invalid JSON"), and distilled only
        // sends one when a body member carries a value.
        deleteUnassignedEnvironmentVariables:
          olds?.deleteUnassignedEnvironmentVariables ?? false,
        ...team,
      }).pipe(
        // Already gone (project cascade, out-of-band delete, or a re-run
        // after a state persistence failure) is success, not an error.
        Effect.catchTag("NotFound", () => Effect.void),
      );
    }),
    // Parent fan-out: custom environments are scoped to a project and have no
    // team-wide enumeration API, so enumerate every project and list each
    // project's environments.
    list: Effect.fn(function* () {
      const team = yield* teamScope;
      const projects: { id: string }[] = [];
      let from: string | undefined;
      // Bounded pagination: both pagination shapes carry `next`
      // (timestamp or continuation token); stop when it's exhausted.
      for (let page = 0; page < 20; page++) {
        const res = yield* getProjects({
          limit: "100",
          ...(from !== undefined ? { from } : {}),
          ...team,
        });
        const items = Array.isArray(res) ? res : res.projects;
        projects.push(...items.map((p) => ({ id: p.id })));
        const next = Array.isArray(res) ? null : res.pagination.next;
        if (items.length === 0 || next === null || next === undefined) break;
        from = String(next);
      }
      const perProject = yield* Effect.forEach(
        projects,
        (project) =>
          getProjectsByIdOrNameCustomEnvironments({
            idOrName: project.id,
            ...team,
          }).pipe(
            Effect.map((res) =>
              res.environments.map((env) => toAttributes(env, project.id)),
            ),
            // The project may be deleted between enumeration and listing.
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          ),
        { concurrency: 10 },
      );
      return perProject.flat();
    }),
  });
