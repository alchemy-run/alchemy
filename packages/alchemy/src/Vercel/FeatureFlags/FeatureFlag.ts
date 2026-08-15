import * as featureFlags from "@distilled.cloud/vercel/feature_flags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { teamScope } from "./internal.ts";

/** The value type of a feature flag. Immutable — changing it replaces the flag. */
export type FlagKind = "boolean" | "string" | "number" | "json";

/** Lifecycle state of a flag. */
export type FlagState = "active" | "archived";

/** One of the values a flag can resolve to, referenced by outcomes and rules. */
export interface FlagVariant {
  /** The id of the variant, referenced by outcomes (e.g. `"on"`). */
  id: string;
  /** The value served when this variant is selected. */
  value: unknown;
  /** A human-readable label for the variant. */
  label?: string;
  /** A description of the variant. */
  description?: string;
}

/** An outcome that resolves the flag to a single fixed variant. */
export interface FlagVariantOutcome {
  type: "variant";
  /** The id of the variant to serve. */
  variantId: string;
}

/**
 * An outcome a rule or fallthrough resolves to: a fixed variant, a weighted
 * split, or a progressive rollout (mirrors the REST API's outcome grammar).
 */
export type FlagOutcome =
  featureFlags.CreateFlagRequestEnvironmentsValueRulesItemOutcome;

/**
 * A targeting rule evaluated in order: an `id`, `conditions` AND-ed together
 * (the REST API's `lhs`/`cmp`/`rhs` grammar), and the `outcome` served when
 * they all match.
 */
export type FlagRule = featureFlags.CreateFlagRequestEnvironmentsValueRulesItem;

/**
 * Direct variant targeting, bypassing the flag's rules:
 * variant id → attribute kind → attribute name → targeted values.
 */
export type FlagTargets =
  featureFlags.CreateFlagRequestEnvironmentsValueTargetsMap;

/** Per-environment configuration of a flag. */
export interface FlagEnvironmentConfig {
  /**
   * Whether the flag is evaluated in this environment. When `false`, the
   * `pausedOutcome` is served.
   * @default true
   */
  active?: boolean;
  /**
   * Outcome served while the environment is paused (`active: false`). The
   * API requires one for every environment; when omitted it defaults to the
   * environment's `fallthrough`, which must then be a fixed variant.
   */
  pausedOutcome?: FlagVariantOutcome;
  /** Outcome when no rule matches. */
  fallthrough: FlagOutcome;
  /**
   * Targeting rules evaluated in order.
   * @default []
   */
  rules?: FlagRule[];
  /** Direct variant targeting, bypassing rules. */
  targets?: FlagTargets;
  /** Link this environment to another environment's configuration. */
  reuse?: { active: boolean; environment: string };
}

/**
 * A flag environment is misconfigured in a way the API would reject —
 * surfaced at reconcile time before any API call is made.
 */
export class FeatureFlagConfigError extends Data.TaggedError(
  "Vercel.FeatureFlagConfigError",
)<{
  readonly environment: string;
  readonly message: string;
}> {}

export interface FeatureFlagProps {
  /**
   * The project the flag lives on: a project id (`prj_…`) or project name.
   * Changing the project replaces the flag.
   */
  project: string;
  /**
   * A unique (per project) key for the flag, composed of letters, numbers,
   * dashes, and underscores. If omitted, a unique slug is generated from
   * `${app}-${stage}-${id}`. Changing the slug replaces the flag.
   */
  slug?: string;
  /**
   * The value type of the flag. Immutable — changing it replaces the flag.
   */
  kind: FlagKind;
  /**
   * The variants the flag can resolve to. Outcomes reference these by id.
   */
  variants?: FlagVariant[];
  /**
   * Per-environment configuration, keyed by environment (`production`,
   * `preview`, `development`, or a custom environment slug).
   */
  environments: Readonly<Record<string, FlagEnvironmentConfig>>;
  /** A description of the flag. */
  description?: string;
  /**
   * Lifecycle state of the flag.
   * @default "active"
   */
  state?: FlagState;
  /**
   * Whether the flag is marked permanent (should not be removed).
   * @default false
   */
  permanent?: boolean;
  /** Tags for categorizing the flag. */
  tags?: string[];
  /** User ids of the flag's maintainers. */
  maintainerIds?: string[];
  /**
   * A random seed preventing split points in different flags from sharing
   * targets. Assigned by Vercel when omitted.
   */
  seed?: number;
}

export type FeatureFlag = Resource<
  "Vercel.FeatureFlag",
  FeatureFlagProps,
  {
    /** The flag id (`flg_…`). */
    flagId: string;
    /** The flag's per-project key. */
    slug: string;
    /** The id of the project the flag lives on. */
    projectId: string;
    /** The value type of the flag. */
    kind: string;
    /** Lifecycle state as reported by Vercel. */
    state: string;
    /** Monotonic revision, bumped on every update. */
    revision: number;
    /** The split-point seed assigned to the flag. */
    seed: number;
    /** Creation time in epoch milliseconds. */
    createdAt: number;
    /** Last update time in epoch milliseconds. */
    updatedAt: number;
  },
  never,
  Providers
>;

type FeatureFlagAttributes = FeatureFlag["Attributes"];

/**
 * A Vercel Feature Flag — a typed, per-project flag evaluated by the Flags
 * SDK, with per-environment activation, targeting rules, and progressive
 * rollouts.
 *
 * @resource
 * @section Creating a flag
 * @example A boolean flag
 * ```typescript
 * const project = yield* Vercel.Project("Api", {});
 * const flag = yield* Vercel.FeatureFlag("UploadsEnabled", {
 *   project: project.projectId,
 *   kind: "boolean",
 *   variants: [
 *     { id: "on", value: true },
 *     { id: "off", value: false },
 *   ],
 *   environments: {
 *     production: { fallthrough: { type: "variant", variantId: "off" } },
 *     preview: { fallthrough: { type: "variant", variantId: "on" } },
 *   },
 * });
 * ```
 *
 * @example A string flag with an explicit slug
 * ```typescript
 * yield* Vercel.FeatureFlag("Banner", {
 *   project: project.projectId,
 *   slug: "banner-text",
 *   kind: "string",
 *   variants: [
 *     { id: "default", value: "Welcome!" },
 *     { id: "sale", value: "Sale on now" },
 *   ],
 *   environments: {
 *     production: { fallthrough: { type: "variant", variantId: "default" } },
 *   },
 * });
 * ```
 *
 * @section Pausing an environment
 * @example Deactivate production, serving the paused outcome
 * ```typescript
 * yield* Vercel.FeatureFlag("UploadsEnabled", {
 *   project: project.projectId,
 *   kind: "boolean",
 *   variants: [
 *     { id: "on", value: true },
 *     { id: "off", value: false },
 *   ],
 *   environments: {
 *     production: {
 *       active: false,
 *       pausedOutcome: { type: "variant", variantId: "off" },
 *       fallthrough: { type: "variant", variantId: "on" },
 *     },
 *   },
 * });
 * ```
 *
 * @see https://vercel.com/docs/feature-flags
 */
export const FeatureFlag = Resource<FeatureFlag>("Vercel.FeatureFlag");

const createFlagSlug = (id: string) =>
  createPhysicalName({ id, lowercase: true });

/** The wire shape of one environment's config (API-required fields filled). */
interface WireEnvironment {
  active: boolean;
  pausedOutcome: FlagVariantOutcome;
  fallthrough: FlagOutcome;
  rules: FlagRule[];
  targets?: FlagTargets;
  reuse?: { active: boolean; environment: string };
}

const isVariantOutcome = (o: FlagOutcome): o is FlagVariantOutcome =>
  typeof o === "object" &&
  o !== null &&
  "variantId" in o &&
  !("base" in o) &&
  (o as { type?: unknown }).type === "variant";

const wireEnvironments = (
  environments: Readonly<Record<string, FlagEnvironmentConfig>>,
) =>
  Effect.gen(function* () {
    const out: Record<string, WireEnvironment> = {};
    for (const [name, env] of Object.entries(environments)) {
      const pausedOutcome =
        env.pausedOutcome ??
        (isVariantOutcome(env.fallthrough) ? env.fallthrough : undefined);
      if (pausedOutcome === undefined) {
        return yield* Effect.fail(
          new FeatureFlagConfigError({
            environment: name,
            message:
              "pausedOutcome is required when fallthrough is not a fixed variant outcome",
          }),
        );
      }
      out[name] = {
        active: env.active ?? true,
        pausedOutcome,
        fallthrough: env.fallthrough,
        rules: env.rules ?? [],
        ...(env.targets !== undefined ? { targets: env.targets } : {}),
        ...(env.reuse !== undefined ? { reuse: env.reuse } : {}),
      };
    }
    return out;
  });

/** Canonical JSON (sorted keys, `undefined` dropped) for drift comparison. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, function replacer(_key, v) {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return v;
  });

/**
 * Normalize an environments map for comparison: strip response-only
 * bookkeeping (per-environment `revision`) and empty `targets` maps so an
 * omitted desired value never churns against an empty observed one.
 */
const normalizeEnvironments = (environments: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(environments).map(([name, env]) => {
      if (env !== null && typeof env === "object") {
        const {
          revision: _revision,
          targets,
          ...rest
        } = env as Record<string, unknown>;
        const keepTargets =
          targets !== null &&
          typeof targets === "object" &&
          Object.keys(targets as object).length > 0;
        return [name, keepTargets ? { ...rest, targets } : rest];
      }
      return [name, env];
    }),
  );

const toAttributes = (flag: {
  id: string;
  slug: string;
  projectId: string;
  kind: string;
  state: string;
  revision: number;
  seed: number;
  createdAt: number;
  updatedAt: number;
}): FeatureFlagAttributes => ({
  flagId: flag.id,
  slug: flag.slug,
  projectId: flag.projectId,
  kind: flag.kind,
  state: flag.state,
  revision: flag.revision,
  seed: flag.seed,
  createdAt: flag.createdAt,
  updatedAt: flag.updatedAt,
});

export const FeatureFlagProvider = () =>
  Provider.succeed(FeatureFlag, {
    stables: ["flagId", "projectId", "slug", "kind", "seed", "createdAt"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      if (olds?.project !== undefined && news.project !== olds.project) {
        return { action: "replace" } as const;
      }
      // The slug is the flag's identity within the project and updateFlag
      // cannot rename; an explicit slug change is a replacement. (An
      // omitted slug means the generated one, which is stable.)
      const oldSlug = olds?.slug ?? output?.slug;
      if (
        news.slug !== undefined &&
        oldSlug !== undefined &&
        news.slug !== oldSlug
      ) {
        return { action: "replace" } as const;
      }
      // The kind (value type) is immutable on the API.
      const oldKind = output?.kind ?? olds?.kind;
      if (oldKind !== undefined && news.kind !== oldKind) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const scope = yield* teamScope;
      const project = output?.projectId ?? olds?.project;
      if (project === undefined) return undefined;
      const flagIdOrSlug =
        output?.flagId ??
        output?.slug ??
        olds?.slug ??
        (yield* createFlagSlug(id));
      const observed = yield* featureFlags
        .getFlag({ projectIdOrName: project, flagIdOrSlug, ...scope })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      return observed === undefined ? undefined : toAttributes(observed);
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const scope = yield* teamScope;
      const slug = news.slug ?? output?.slug ?? (yield* createFlagSlug(id));
      const desiredEnvironments = yield* wireEnvironments(news.environments);

      // Observe — the cloud flag is authoritative; `output` only caches the
      // stable id.
      const observed = yield* featureFlags
        .getFlag({
          projectIdOrName: news.project,
          flagIdOrSlug: output?.flagId ?? slug,
          ...scope,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

      // Ensure — missing → create. A Conflict (`flag_exists`) is a
      // concurrent-create race: re-read the winner and fall through.
      if (observed === undefined) {
        const created = yield* featureFlags
          .createFlag({
            projectIdOrName: news.project,
            slug,
            kind: news.kind,
            environments: desiredEnvironments,
            ...(news.variants !== undefined ? { variants: news.variants } : {}),
            ...(news.description !== undefined
              ? { description: news.description }
              : {}),
            ...(news.state !== undefined ? { state: news.state } : {}),
            ...(news.permanent !== undefined
              ? { permanent: news.permanent }
              : {}),
            ...(news.tags !== undefined ? { tags: news.tags } : {}),
            ...(news.maintainerIds !== undefined
              ? { maintainerIds: news.maintainerIds }
              : {}),
            ...(news.seed !== undefined ? { seed: news.seed } : {}),
            ...scope,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              featureFlags.getFlag({
                projectIdOrName: news.project,
                flagIdOrSlug: slug,
                ...scope,
              }),
            ),
          );
        return toAttributes(created);
      }

      // Sync — diff OBSERVED cloud state against the desired wire shape and
      // PATCH only the drifted fields (updateFlag supports partial updates).
      const patch: {
        environments?: typeof desiredEnvironments;
        variants?: FlagVariant[];
        description?: string;
        state?: FlagState;
        permanent?: boolean;
        tags?: string[];
        maintainerIds?: string[];
        seed?: number;
      } = {};
      if (
        canonical(
          normalizeEnvironments(
            observed.environments as Record<string, unknown>,
          ),
        ) !== canonical(normalizeEnvironments(desiredEnvironments))
      ) {
        patch.environments = desiredEnvironments;
      }
      if (
        news.variants !== undefined &&
        canonical(observed.variants) !== canonical(news.variants)
      ) {
        patch.variants = news.variants;
      }
      if ((observed.description ?? undefined) !== news.description) {
        patch.description = news.description ?? "";
      }
      const desiredState = news.state ?? "active";
      if (observed.state !== desiredState) patch.state = desiredState;
      const desiredPermanent = news.permanent ?? false;
      if ((observed.permanent ?? false) !== desiredPermanent) {
        patch.permanent = desiredPermanent;
      }
      if (
        news.tags !== undefined &&
        canonical([...(observed.tags ?? [])].sort()) !==
          canonical([...news.tags].sort())
      ) {
        patch.tags = news.tags;
      }
      if (
        news.maintainerIds !== undefined &&
        canonical([...(observed.maintainerIds ?? [])].sort()) !==
          canonical([...news.maintainerIds].sort())
      ) {
        patch.maintainerIds = news.maintainerIds;
      }
      if (news.seed !== undefined && observed.seed !== news.seed) {
        patch.seed = news.seed;
      }

      if (Object.keys(patch).length === 0) {
        return toAttributes(observed);
      }
      const updated = yield* featureFlags.updateFlag({
        projectIdOrName: news.project,
        flagIdOrSlug: observed.id,
        ...patch,
        ...scope,
      });
      return toAttributes(updated);
    }),
    delete: Effect.fn(function* ({ output }) {
      const scope = yield* teamScope;
      // Already gone (out-of-band delete, or a deleted host project) is
      // success, not an error.
      yield* featureFlags
        .deleteFlag({
          projectIdOrName: output.projectId,
          flagIdOrSlug: output.flagId,
          ...scope,
        })
        .pipe(
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
        );
    }),
  });
