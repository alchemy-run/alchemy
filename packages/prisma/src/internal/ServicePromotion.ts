import {
  getService,
  createServicePromote,
  createServiceRollback,
} from "@distilled.cloud/prisma/management";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { type ComputeUrlCheck, waitForComputeUrl } from "./UrlCheck.ts";

export class ComputeServicePromotionInvalidProps extends Data.TaggedError(
  "ComputeServicePromotionInvalidProps",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The service never reported the version as its latest before the wait timed out. */
export class ComputeServiceActiveVersionTimeout extends Data.TaggedError(
  "ComputeServiceActiveVersionTimeout",
)<{
  readonly message: string;
  readonly errors: readonly unknown[];
  readonly cause?: unknown;
}> {}

/**
 * Promotion of a deployment did not converge (and recovery, if attempted,
 * also failed). The deployment is preserved because commit state is ambiguous.
 */
export class ComputeServicePromotionNotConverged extends Data.TaggedError(
  "ComputeServicePromotionNotConverged",
)<{
  readonly message: string;
  readonly errors: readonly unknown[];
  readonly cause?: unknown;
}> {}

export interface ActiveVersionObservationOptions {
  readonly timeoutSeconds?: number;
  readonly pollIntervalMs?: number;
}

const DEFAULT_TIMEOUT_SECONDS = 60;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export const waitForActiveVersion = Effect.fn(function* (
  appId: string,
  deploymentId: string,
  options: ActiveVersionObservationOptions = {},
) {
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return yield* new ComputeServicePromotionInvalidProps({
      message: "timeoutSeconds must be a positive finite number.",
    });
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return yield* new ComputeServicePromotionInvalidProps({
      message: "pollIntervalMs must be a positive finite number.",
    });
  }

  const timeoutMs = timeoutSeconds * 1_000;
  const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
  let lastLatestDeploymentId: string | null | undefined;
  let lastError: unknown;

  while (true) {
    const remainingBeforeObservation = deadline - (yield* Clock.currentTimeMillis);
    if (remainingBeforeObservation <= 0) break;

    const observationOption = yield* getService({ serviceId: appId }).pipe(
      Effect.map((response) => response.data),
      Effect.result,
      Effect.timeoutOption(Duration.millis(remainingBeforeObservation)),
    );
    if (Option.isNone(observationOption)) break;
    const observation = observationOption.value;
    if (Result.isSuccess(observation)) {
      lastLatestDeploymentId = observation.success.latestDeploymentId;
      lastError = undefined;
      if (lastLatestDeploymentId === deploymentId) {
        return observation.success;
      }
    } else {
      lastError = observation.failure;
    }

    const remainingAfterObservation = deadline - (yield* Clock.currentTimeMillis);
    if (remainingAfterObservation <= 0) break;
    yield* Effect.sleep(Duration.millis(Math.min(intervalMs, remainingAfterObservation)));
  }

  return yield* new ComputeServiceActiveVersionTimeout({
    message: `Timed out waiting for Prisma Compute service '${appId}' to report deployment '${deploymentId}' as latest (last observed latest deployment: '${lastLatestDeploymentId ?? "none"}').`,
    errors: lastError === undefined ? [] : [lastError],
    cause: lastError,
  });
});

/**
 * Promote a version and recover response loss by observing the service.
 * Every successful mutation is followed by bounded observation of the service
 * row before callers may probe stable readiness or delete another deployment.
 * If the promotion response is lost, the canonical rollback primitive heals
 * an already-flipped Foundry endpoint or safely completes the target
 * promotion. Any non-converged result is ambiguous and must never trigger
 * target deletion.
 */
export const promoteVersionObserved = Effect.fn(function* (
  appId: string,
  deploymentId: string,
  options: ActiveVersionObservationOptions = {},
) {
  const promoted = yield* createServicePromote({
    serviceId: appId,
    deploymentId,
  }).pipe(
    Effect.map((response) => response.data),
    Effect.result,
  );
  if (Result.isSuccess(promoted)) {
    const observation = yield* waitForActiveVersion(appId, deploymentId, options).pipe(
      Effect.result,
    );
    if (Result.isFailure(observation)) {
      return yield* new ComputeServicePromotionNotConverged({
        message: `Prisma Compute service '${appId}' promotion returned success for deployment '${deploymentId}', but the service did not converge to that target. The deployment was preserved because promotion commit state is ambiguous.`,
        errors: [observation.failure],
        cause: observation.failure,
      });
    }
    return {
      ...promoted.success,
      appEndpointDomain: observation.success.appEndpointDomain,
    };
  }

  const observation = yield* getService({ serviceId: appId }).pipe(
    Effect.map((response) => response.data),
    Effect.result,
  );
  if (Result.isSuccess(observation) && observation.success.latestDeploymentId === deploymentId) {
    return {
      appEndpointDomain: observation.success.appEndpointDomain,
      reassignedDomains: 0,
    };
  }
  const repaired = yield* createServiceRollback({
    serviceId: appId,
    deploymentId,
  }).pipe(
    Effect.map((response) => response.data),
    Effect.result,
  );
  const observeRepaired: Effect.Effect<
    Effect.Success<ReturnType<typeof waitForActiveVersion>>,
    | Effect.Error<ReturnType<typeof waitForActiveVersion>>
    | Effect.Error<ReturnType<typeof getService>>,
    Effect.Services<ReturnType<typeof waitForActiveVersion>>
  > = Result.isSuccess(repaired)
    ? waitForActiveVersion(appId, deploymentId, options)
    : getService({ serviceId: appId }).pipe(Effect.map((response) => response.data));
  const repairedObservation = yield* Effect.result(observeRepaired);
  if (
    Result.isSuccess(repairedObservation) &&
    repairedObservation.success.latestDeploymentId === deploymentId
  ) {
    return Result.isSuccess(repaired)
      ? {
          ...repaired.success,
          appEndpointDomain: repairedObservation.success.appEndpointDomain,
        }
      : {
          appEndpointDomain: repairedObservation.success.appEndpointDomain,
          reassignedDomains: 0,
        };
  }
  return yield* new ComputeServicePromotionNotConverged({
    cause: promoted.failure,
    errors: [
      promoted.failure,
      ...(Result.isFailure(observation) ? [observation.failure] : []),
      ...(Result.isFailure(repaired) ? [repaired.failure] : []),
      ...(Result.isFailure(repairedObservation)
        ? [repairedObservation.failure]
        : [
            new Error(
              `Prisma Compute service '${appId}' still reports deployment '${repairedObservation.success.latestDeploymentId ?? "none"}' as latest after canonical recovery targeted '${deploymentId}'.`,
            ),
          ]),
    ],
    message: `Prisma Compute service '${appId}' promotion of deployment '${deploymentId}' failed and canonical recovery also failed. The deployment was not deleted because endpoint commit state is ambiguous.`,
  });
});

/**
 * What {@link checkStableEndpoint} found after a promotion.
 *
 * - `Ready`: the stable URL answered.
 * - `NoRollbackTarget`: it did not, and there was no earlier version to restore.
 * - `RolledBack`: it did not, and the service reports the earlier version as
 *   live again. `rollbackFailure` is set when the rollback call itself failed
 *   but the service converged anyway.
 * - `RollbackRefused`: it did not, and the platform refused the rollback.
 *   Only reported with `stopWhenRollbackRefused`; otherwise the check waits
 *   for the earlier version anyway.
 * - `RollbackNotConverged`: it did not, and the service never reported the
 *   earlier version as live.
 */
type ReadinessFailure = Effect.Error<ReturnType<typeof waitForComputeUrl>>;
type RollbackFailure = Effect.Error<ReturnType<typeof createServiceRollback>>;
type ObservationFailure = Effect.Error<ReturnType<typeof waitForActiveVersion>>;

export type StableEndpointCheck =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "NoRollbackTarget"; readonly readinessFailure: ReadinessFailure }
  | {
      readonly _tag: "RolledBack";
      readonly readinessFailure: ReadinessFailure;
      readonly rollbackFailure: RollbackFailure | undefined;
    }
  | {
      readonly _tag: "RollbackRefused";
      readonly readinessFailure: ReadinessFailure;
      readonly rollbackFailure: RollbackFailure;
    }
  | {
      readonly _tag: "RollbackNotConverged";
      readonly readinessFailure: ReadinessFailure;
      readonly rollbackFailure: RollbackFailure | undefined;
      readonly observationFailure: ObservationFailure;
    };

/**
 * Wait for a promoted service's stable URL. When it never answers and an
 * earlier version is known, roll the service back to it and wait until the
 * service reports it as live again.
 */
export const checkStableEndpoint = Effect.fn(function* (
  serviceId: string,
  url: string | undefined,
  rollbackVersionId: string | undefined,
  options: ComputeUrlCheck &
    ActiveVersionObservationOptions & {
      /** Report a refused rollback at once instead of waiting for the earlier version. */
      readonly stopWhenRollbackRefused?: boolean;
    },
) {
  const readiness = yield* waitForComputeUrl(url, options).pipe(Effect.result);
  if (Result.isSuccess(readiness)) return { _tag: "Ready" } satisfies StableEndpointCheck;
  if (rollbackVersionId === undefined) {
    return {
      _tag: "NoRollbackTarget",
      readinessFailure: readiness.failure,
    } satisfies StableEndpointCheck;
  }
  const rollback = yield* createServiceRollback({
    serviceId,
    deploymentId: rollbackVersionId,
  }).pipe(Effect.result);
  const rollbackFailure = Result.isFailure(rollback) ? rollback.failure : undefined;
  if (rollbackFailure !== undefined && options.stopWhenRollbackRefused) {
    return {
      _tag: "RollbackRefused",
      readinessFailure: readiness.failure,
      rollbackFailure,
    } satisfies StableEndpointCheck;
  }
  const observed = yield* waitForActiveVersion(serviceId, rollbackVersionId, options).pipe(
    Effect.result,
  );
  return Result.isSuccess(observed)
    ? ({
        _tag: "RolledBack",
        readinessFailure: readiness.failure,
        rollbackFailure,
      } satisfies StableEndpointCheck)
    : ({
        _tag: "RollbackNotConverged",
        readinessFailure: readiness.failure,
        rollbackFailure,
        observationFailure: observed.failure,
      } satisfies StableEndpointCheck);
});
