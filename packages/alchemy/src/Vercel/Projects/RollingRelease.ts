import * as rolling_release from "@distilled.cloud/vercel/rolling_release";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { VercelEnvironment } from "../VercelEnvironment.ts";

/** How a rollout advances between stages. */
export type RollingReleaseAdvancementType = "automatic" | "manual-approval";

/** One stage of a rolling release. The final stage must be 100%. */
export interface RollingReleaseStage {
  /** The percentage of traffic to serve to the canary deployment (0-100). */
  targetPercentage: number;
  /**
   * Duration in minutes before automatically advancing to the next stage.
   * Only meaningful with `advancementType: "automatic"`.
   */
  duration?: number;
  /**
   * Whether this stage requires manual approval to proceed. Only
   * meaningful with `advancementType: "manual-approval"`.
   */
  requireApproval?: boolean;
}

export interface RollingReleaseProps {
  /**
   * The project the rolling release configuration is attached to: a
   * project id (`prj_…`) or project name. A project has at most one
   * rolling release configuration; changing the project replaces the
   * resource (the old project's configuration is deleted).
   */
  project: string;
  /**
   * How the rollout advances between stages: `automatic` (each stage
   * advances after its `duration`) or `manual-approval` (each stage waits
   * for an approve call). Not readable back from the API — drift on this
   * property alone cannot be detected from cloud state.
   */
  advancementType: RollingReleaseAdvancementType;
  /**
   * The traffic stages of a rollout, in order. The final stage must have
   * `targetPercentage: 100` (the API rejects the config otherwise —
   * live-verified `invalid_request`).
   */
  stages: RollingReleaseStage[];
  /**
   * Whether requests served by the canary deployment return a header
   * indicating a canary was served.
   * @default false
   */
  canaryResponseHeader?: boolean;
}

export type RollingRelease = Resource<
  "Vercel.RollingRelease",
  RollingReleaseProps,
  {
    /** The project id or name the configuration is attached to (from props). */
    projectId: string;
    /** The environment the release targets (currently always `production`). */
    target: string;
    /** How the rollout advances between stages (from props; not readable). */
    advancementType: RollingReleaseAdvancementType;
    /** The configured stages as reported by the API. */
    stages: RollingReleaseStage[];
    /** Whether canary responses carry the canary header. */
    canaryResponseHeader: boolean;
  },
  never,
  Providers
>;

type RollingReleaseAttributes = RollingRelease["Attributes"];

/**
 * The rolling release configuration of a Vercel project: new production
 * deployments are gradually rolled out through traffic stages instead of
 * receiving 100% of traffic at once.
 *
 * The configuration is a template for FUTURE rollouts — changing or
 * deleting it never alters a rollout already in flight, only the next
 * production deployment. Deleting the resource disables rolling releases
 * for the project. Note: enabling rolling releases automatically enables
 * skew protection on the project if it wasn't configured already.
 *
 * Requires a plan with rolling release slots (Pro and up); the
 * `getRollingReleaseBillingStatus` API reports the team's entitlement.
 *
 * @resource
 * @section Creating a rolling release configuration
 * @example Manual approval stages
 * ```typescript
 * const project = yield* Vercel.Project("App", {});
 * yield* Vercel.RollingRelease("Rollout", {
 *   project: project.projectId,
 *   advancementType: "manual-approval",
 *   stages: [
 *     { targetPercentage: 10, requireApproval: true },
 *     { targetPercentage: 100 },
 *   ],
 * });
 * ```
 *
 * @example Automatic advancement
 * ```typescript
 * // Each stage serves its traffic share for `duration` minutes, then
 * // advances automatically; the canary header marks canary responses.
 * yield* Vercel.RollingRelease("Rollout", {
 *   project: project.projectId,
 *   advancementType: "automatic",
 *   stages: [
 *     { targetPercentage: 5, duration: 10 },
 *     { targetPercentage: 50, duration: 10 },
 *     { targetPercentage: 100 },
 *   ],
 *   canaryResponseHeader: true,
 * });
 * ```
 *
 * @see https://vercel.com/docs/rolling-releases
 */
export const RollingRelease = Resource<RollingRelease>("Vercel.RollingRelease");

/**
 * Structural view of the observed config (the GET response's
 * `rollingRelease`), used for diffing and attribute mapping.
 */
interface ObservedConfig {
  readonly target: string;
  readonly stages?: ReadonlyArray<{
    readonly targetPercentage: number;
    readonly requireApproval?: boolean;
    readonly duration?: number;
    readonly linearShift?: boolean;
  }> | null;
  readonly canaryResponseHeader?: boolean;
}

const canonicalStages = (
  stages: ReadonlyArray<{
    readonly targetPercentage: number;
    readonly requireApproval?: boolean;
    readonly duration?: number;
  }>,
): RollingReleaseStage[] =>
  stages.map((stage) => ({
    targetPercentage: stage.targetPercentage,
    ...(stage.duration !== undefined ? { duration: stage.duration } : {}),
    ...(stage.requireApproval === true ? { requireApproval: true } : {}),
  }));

const stagesEqual = (
  a: ReadonlyArray<RollingReleaseStage>,
  b: ReadonlyArray<RollingReleaseStage>,
): boolean =>
  a.length === b.length &&
  a.every(
    (stage, i) =>
      stage.targetPercentage === b[i]!.targetPercentage &&
      stage.duration === b[i]!.duration &&
      (stage.requireApproval ?? false) === (b[i]!.requireApproval ?? false),
  );

const toAttributes = (
  project: string,
  observed: ObservedConfig,
  advancementType: RollingReleaseAdvancementType,
): RollingReleaseAttributes => ({
  projectId: project,
  target: observed.target,
  advancementType,
  stages: canonicalStages(observed.stages ?? []),
  canaryResponseHeader: observed.canaryResponseHeader ?? false,
});

/**
 * `advancementType` is not echoed by the GET config API (live-verified);
 * infer it from observed stages when no persisted value survives.
 */
const inferAdvancementType = (
  observed: ObservedConfig,
): RollingReleaseAdvancementType =>
  (observed.stages ?? []).some((stage) => stage.duration !== undefined)
    ? "automatic"
    : "manual-approval";

const getObserved = (idOrName: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    const response = yield* rolling_release.getRollingReleaseConfig({
      idOrName,
      teamId,
    });
    return (response.rollingRelease as ObservedConfig | null) ?? undefined;
  });

export const RollingReleaseProvider = () =>
  Provider.succeed(RollingRelease, {
    stables: ["projectId", "target"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      const oldProject = output?.projectId ?? olds?.project;
      if (oldProject !== undefined && news.project !== oldProject) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const project = output?.projectId ?? olds?.project;
      if (project === undefined) return undefined;
      return yield* getObserved(project).pipe(
        Effect.map((observed) =>
          observed !== undefined
            ? toAttributes(
                project,
                observed,
                output?.advancementType ??
                  olds?.advancementType ??
                  inferAdvancementType(observed),
              )
            : undefined,
        ),
        // Project gone → configuration gone.
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );
    }),
    reconcile: Effect.fn(function* ({ news, olds, output }) {
      const { teamId } = yield* VercelEnvironment.current;
      const desiredStages = canonicalStages(news.stages);
      const desiredCanary = news.canaryResponseHeader ?? false;

      // Observe — the config document is the source of truth for stages and
      // the canary header. `advancementType` is write-only (not echoed by
      // the GET), so `olds` is the no-op hint for it: an observed match
      // still PATCHes when the declared advancementType changed.
      const observed = yield* getObserved(news.project);
      if (
        observed !== undefined &&
        stagesEqual(canonicalStages(observed.stages ?? []), desiredStages) &&
        (observed.canaryResponseHeader ?? false) === desiredCanary &&
        olds?.advancementType === news.advancementType
      ) {
        return toAttributes(news.project, observed, news.advancementType);
      }

      yield* rolling_release.updateRollingReleaseConfig({
        idOrName: news.project,
        teamId,
        enabled: true,
        advancementType: news.advancementType,
        stages: desiredStages,
        canaryResponseHeader: desiredCanary,
      });
      // The PATCH echo is partial (live-verified: stages only) — re-read
      // for authoritative attributes.
      const after = yield* getObserved(news.project);
      if (after === undefined) {
        return yield* Effect.die(
          `Vercel accepted the rolling release config for ${news.project} but the configuration is not visible`,
        );
      }
      return toAttributes(news.project, after, news.advancementType);
    }),
    delete: Effect.fn(function* ({ output }) {
      const { teamId } = yield* VercelEnvironment.current;
      // Disables rolling releases for the project. Idempotent: deleting an
      // absent config returns `{rollingRelease: null}` (live-verified), and
      // a deleted host project surfaces as NotFound — not an error.
      yield* rolling_release
        .deleteRollingReleaseConfig({ idOrName: output.projectId, teamId })
        .pipe(
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
        );
    }),
  });
