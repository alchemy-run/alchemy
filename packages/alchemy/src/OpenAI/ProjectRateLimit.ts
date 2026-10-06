import * as OpenAI from "@distilled.cloud/openai";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

/** The per-model limits a project rate limit can lower. */
export interface RateLimitValues {
  /** Maximum requests per minute. */
  maxRequestsPer1Minute?: number;
  /** Maximum tokens per minute. */
  maxTokensPer1Minute?: number;
  /** Maximum images per minute. Only applies to image models. */
  maxImagesPer1Minute?: number;
  /** Maximum audio megabytes per minute. Only applies to audio models. */
  maxAudioMegabytesPer1Minute?: number;
  /** Maximum requests per day. Only applies to some models. */
  maxRequestsPer1Day?: number;
  /** Maximum batch input tokens per day. Only applies to some models. */
  batch1DayMaxInputTokens?: number;
}

export interface ProjectRateLimitProps extends RateLimitValues {
  /** ID of the project whose limit is managed. Changing it replaces the resource. */
  projectId: string;
  /** Model the limit applies to, e.g. `gpt-5-mini`. Changing it replaces the resource. */
  model: string;
}

export interface ProjectRateLimitAttributes {
  /** ID of the project. */
  projectId: string;
  /** Model the limit applies to. */
  model: string;
  /** The rate limit's ID (`rl-…`). */
  rateLimitId: string;
  /** The limits currently in effect. */
  limits: RateLimitValues;
  /**
   * The limits observed before Alchemy first changed them; restored when the
   * resource is destroyed.
   */
  initialLimits: RateLimitValues;
}

export interface ProjectRateLimit extends Resource<
  "OpenAI.ProjectRateLimit",
  ProjectRateLimitProps,
  ProjectRateLimitAttributes,
  never,
  Providers
> {}

/**
 * The rate limit of one model inside an OpenAI project. Use it to cap how much
 * of the organization's limits a project can consume.
 *
 * Every project has one rate limit per model, created by OpenAI. They cannot be
 * created or deleted, only changed, and a project limit can only be lowered
 * below the organization's limit. This resource therefore manages an existing
 * setting: on first deploy it records the observed limits, and destroying it
 * restores them. Only the fields you set are managed; omitted fields are left
 * untouched.
 *
 * Managed through the Admin API, so it requires an Admin key
 * (`OPENAI_ADMIN_KEY`, `sk-admin-…`).
 *
 * ### Capping a Model
 * **Example:** Limit a project's requests and tokens per minute
 * ```typescript
 * const project = yield* OpenAI.Project("App");
 * yield* OpenAI.ProjectRateLimit("Gpt5MiniLimit", {
 *   projectId: project.projectId,
 *   model: "gpt-5-mini",
 *   maxRequestsPer1Minute: 60,
 *   maxTokensPer1Minute: 100_000,
 * });
 * ```
 *
 * **Example:** Daily request budget
 * ```typescript
 * yield* OpenAI.ProjectRateLimit("DailyBudget", {
 *   projectId: project.projectId,
 *   model: "gpt-5-mini",
 *   maxRequestsPer1Day: 10_000,
 * });
 * ```
 *
 * @resource
 * @product OpenAI
 * @category AI
 */
export const ProjectRateLimit = Resource<ProjectRateLimit>("OpenAI.ProjectRateLimit");

/** The project has no rate limit for the requested model. */
export class ProjectRateLimitModelNotFound extends Data.TaggedError(
  "ProjectRateLimitModelNotFound",
)<{
  readonly projectId: string;
  readonly model: string;
  readonly message: string;
}> {}

type ObservedRateLimit = OpenAI.projects.ProjectRateLimit;

const LIMIT_FIELDS = [
  ["maxRequestsPer1Minute", "max_requests_per_1_minute"],
  ["maxTokensPer1Minute", "max_tokens_per_1_minute"],
  ["maxImagesPer1Minute", "max_images_per_1_minute"],
  ["maxAudioMegabytesPer1Minute", "max_audio_megabytes_per_1_minute"],
  ["maxRequestsPer1Day", "max_requests_per_1_day"],
  ["batch1DayMaxInputTokens", "batch_1_day_max_input_tokens"],
] as const satisfies ReadonlyArray<readonly [keyof RateLimitValues, keyof ObservedRateLimit]>;

const valuesOf = (limit: ObservedRateLimit): RateLimitValues => {
  const values: RateLimitValues = {};
  for (const [prop, wire] of LIMIT_FIELDS) {
    const value = limit[wire];
    if (value !== undefined) values[prop] = value;
  }
  return values;
};

/** The update body that moves `observed` to `desired`, or undefined on no-op. */
const delta = (observed: RateLimitValues, desired: RateLimitValues) => {
  const body: Partial<Record<(typeof LIMIT_FIELDS)[number][1], number>> = {};
  let changed = false;
  for (const [prop, wire] of LIMIT_FIELDS) {
    const want = desired[prop];
    if (want !== undefined && want !== observed[prop]) {
      body[wire] = want;
      changed = true;
    }
  }
  return changed ? body : undefined;
};

/** Find the project's rate limit for `model`; undefined if the project/model is gone. */
const findRateLimit = (projectId: string, model: string) =>
  OpenAI.projects.listProjectRateLimits.items({ project_id: projectId, limit: 100 }).pipe(
    Stream.filter((limit) => limit.model === model),
    Stream.runHead,
    Effect.map((head) => (head._tag === "Some" ? head.value : undefined)),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const projectIsLive = (projectId: string) =>
  OpenAI.projects.getProject({ project_id: projectId }).pipe(
    Effect.map(
      (project) => project.status !== "archived" && (project.archived_at ?? null) === null,
    ),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

export const ProjectRateLimitProvider = () =>
  Provider.succeed(ProjectRateLimit, {
    stables: ["projectId", "model", "rateLimitId", "initialLimits"],
    // Every project/model pair always has a limit; there is nothing to enumerate
    // for teardown, and "deleting" one only restores a captured baseline.
    nuke: { singleton: true },
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      if (
        news.projectId !== (output?.projectId ?? olds.projectId) ||
        news.model !== (output?.model ?? olds.model)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ output }) {
      // Without a captured baseline there is nothing of ours to read: reconcile
      // captures it on first deploy.
      if (output === undefined) return undefined;
      const observed = yield* findRateLimit(output.projectId, output.model);
      if (observed === undefined) return undefined;
      return { ...output, rateLimitId: observed.id, limits: valuesOf(observed) };
    }),
    reconcile: Effect.fn(function* ({ news, olds, output }) {
      // 1. Observe the always-present limit for this project/model.
      const observed = yield* findRateLimit(news.projectId, news.model);
      if (observed === undefined) {
        return yield* new ProjectRateLimitModelNotFound({
          projectId: news.projectId,
          model: news.model,
          message: `OpenAI project ${news.projectId} has no rate limit for model "${news.model}". Check the model ID against the project's rate limits page.`,
        });
      }
      const current = valuesOf(observed);
      // Capture the baseline once; a baseline from another project/model is stale.
      const initialLimits =
        output !== undefined && output.projectId === news.projectId && output.model === news.model
          ? output.initialLimits
          : current;

      // 2. Sync only the fields the user manages, and only when they differ. A
      // field that was managed before but is now omitted goes back to baseline.
      const desired: RateLimitValues = {};
      for (const [prop] of LIMIT_FIELDS) {
        desired[prop] =
          news[prop] ?? (olds?.[prop] !== undefined ? initialLimits[prop] : undefined);
      }
      const body = delta(current, desired);
      const final = body
        ? yield* OpenAI.projects.updateProjectRateLimits({
            project_id: news.projectId,
            rate_limit_id: observed.id,
            ...body,
          })
        : observed;

      return {
        projectId: news.projectId,
        model: news.model,
        rateLimitId: final.id,
        limits: valuesOf(final),
        initialLimits,
      };
    }),
    delete: Effect.fn(function* ({ output, olds }) {
      // Archived projects reject updates and serve no traffic: nothing to restore.
      if (!(yield* projectIsLive(output.projectId))) return;
      const observed = yield* findRateLimit(output.projectId, output.model);
      if (observed === undefined) return;
      // Restore only the fields this resource managed.
      const managed: RateLimitValues = {};
      for (const [prop] of LIMIT_FIELDS) {
        if (olds?.[prop] !== undefined) managed[prop] = output.initialLimits[prop];
      }
      const body = delta(valuesOf(observed), managed);
      if (body === undefined) return;
      yield* OpenAI.projects
        .updateProjectRateLimits({
          project_id: output.projectId,
          rate_limit_id: observed.id,
          ...body,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
