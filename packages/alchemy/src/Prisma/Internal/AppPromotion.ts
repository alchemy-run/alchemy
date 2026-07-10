import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { PrismaManagementClient } from "../Client.ts";
import type { PromoteAppResult } from "../Types.ts";

/**
 * Promote an App and recover response loss by observing the canonical App.
 * If the App row did not commit, the canonical rollback primitive heals an
 * already-flipped Foundry endpoint or safely completes the target promotion.
 * A failure from both operations is ambiguous and must never trigger target
 * deletion.
 */
export const promoteAppObserved = Effect.fn(function* (
  client: PrismaManagementClient,
  appId: string,
  deploymentId: string,
): Effect.fn.Return<PromoteAppResult, Error> {
  const promoted = yield* client
    .promoteApp(appId, { deploymentId })
    .pipe(Effect.result);
  if (Result.isSuccess(promoted)) return promoted.success;

  const observation = yield* client.getApp(appId).pipe(Effect.result);
  if (
    Result.isSuccess(observation) &&
    observation.success.latestDeploymentId === deploymentId
  ) {
    return {
      appEndpointDomain: observation.success.appEndpointDomain,
      reassignedDomains: 0,
    };
  }
  const repaired = yield* client
    .rollbackApp(appId, { deploymentId })
    .pipe(Effect.result);
  if (Result.isSuccess(repaired)) return repaired.success;
  return yield* Effect.fail(
    new AggregateError(
      [
        promoted.failure,
        ...(Result.isFailure(observation) ? [observation.failure] : []),
        repaired.failure,
      ],
      `Prisma App '${appId}' promotion of deployment '${deploymentId}' failed and canonical recovery also failed. The deployment was not deleted because endpoint commit state is ambiguous.`,
    ),
  );
});
