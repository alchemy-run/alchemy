/**
 * Promote / rollback runtime actions — plain Effects, not resources.
 *
 * The platform's promote and rollback are dedicated endpoints on the
 * `projects` service (`POST /v10/projects/{projectId}/promote/{deploymentId}`
 * and `POST /v1/projects/{projectId}/rollback/{deploymentId}`), NOT alias
 * re-assignment by the caller: Vercel re-points the project's production
 * alias(es) itself and records the operation in the project's
 * `lastAliasRequest` (`type: "promote" | "rollback"`). Both are pure
 * traffic operations over already-built deployments — the promote endpoint
 * documents "this does NOT rebuild the deployment".
 */
import * as projects from "@distilled.cloud/vercel/projects";
import * as Effect from "effect/Effect";
import { VercelEnvironment } from "../VercelEnvironment.ts";

/**
 * The project (and optionally the deployment) a promote/rollback targets —
 * a resource carrying `projectId` (e.g. a `Vercel.Function`'s attributes,
 * whose `deploymentId` is its current deployment) or a plain project id.
 */
export type PromoteTarget =
  | { projectId: string; deploymentId?: string }
  | string;

const resolveTarget = (
  target: PromoteTarget,
  deploymentId: string | undefined,
  action: string,
) =>
  Effect.gen(function* () {
    const projectId = typeof target === "string" ? target : target.projectId;
    const resolved =
      deploymentId ??
      (typeof target === "string" ? undefined : target.deploymentId);
    if (resolved === undefined) {
      return yield* Effect.die(
        `Vercel.${action}: no deploymentId — pass one explicitly or target a resource carrying a deploymentId (e.g. a Vercel.Function)`,
      );
    }
    return { projectId, deploymentId: resolved };
  });

/**
 * Point a project's production alias(es) at the given deployment.
 *
 * A pure traffic re-point over an already-built deployment (retained
 * deployments are never rebuilt). Defaults to the target's own
 * `deploymentId` when a `Vercel.Function` (or its attributes) is passed,
 * so `promoteToProduction(fn)` promotes the function's current deployment.
 *
 * ```typescript
 * // promote a specific retained deployment to production
 * yield* Vercel.promoteToProduction(fn.projectId, "dpl_123abc");
 * ```
 */
export const promoteToProduction = (
  target: PromoteTarget,
  deploymentId?: string,
) =>
  Effect.gen(function* () {
    const resolved = yield* resolveTarget(
      target,
      deploymentId,
      "promoteToProduction",
    );
    const { teamId } = yield* VercelEnvironment.current;
    yield* projects.requestPromote({ ...resolved, teamId });
  });

/**
 * Roll production back to a previous production deployment.
 *
 * Instant rollback: like {@link promoteToProduction} this only re-points
 * production traffic — nothing is rebuilt — but the endpoint additionally
 * verifies the target was previously promoted and records the operation as
 * a rollback (with the optional `description`) in the project's
 * `lastAliasRequest`.
 *
 * ```typescript
 * yield* Vercel.rollbackProduction(fn.projectId, previousDeploymentId, {
 *   description: "beta.46 regression",
 * });
 * ```
 */
export const rollbackProduction = (
  target: PromoteTarget,
  deploymentId?: string,
  options?: { description?: string },
) =>
  Effect.gen(function* () {
    const resolved = yield* resolveTarget(
      target,
      deploymentId,
      "rollbackProduction",
    );
    const { teamId } = yield* VercelEnvironment.current;
    yield* projects.requestRollback({
      ...resolved,
      teamId,
      ...(options?.description !== undefined
        ? { description: options.description }
        : {}),
    });
  });
