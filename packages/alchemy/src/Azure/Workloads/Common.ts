import * as workloads from "@distilled.cloud/azure/workloads";
import * as Effect from "effect/Effect";
import {
  orUndefinedIfNotFound,
  ProvisioningFailed,
  stackAndStage,
} from "../Arm.ts";

export const getMonitor = (
  subscriptionId: string,
  resourceGroupName: string,
  monitorName: string,
) =>
  orUndefinedIfNotFound(
    workloads.GetMonitor({ subscriptionId, resourceGroupName, monitorName }),
  );

/**
 * Monitor children (provider instances, the landscape monitor) carry no
 * tags. They count as owned when their parent monitor carries this stack's
 * and stage's ownership tags.
 */
export const monitorOwnedByStage = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  monitorName: string,
) {
  const observed = yield* getMonitor(
    subscriptionId,
    resourceGroupName,
    monitorName,
  );
  const { stack, stage } = yield* stackAndStage;
  return (
    observed?.tags?.["alchemy::stack"] === stack &&
    observed?.tags?.["alchemy::stage"] === stage
  );
});

/**
 * Sorted, lower-cased user-assigned identity ARM ids, for comparing desired
 * and observed identities.
 */
export const identityIds = (
  ids: Iterable<string> | undefined,
): string[] => [...(ids ?? [])].map((id) => id.toLowerCase()).sort();

/** The ARM `identity` block for a list of user-assigned identity ids. */
export const identityBlock = (ids: readonly string[] | undefined) =>
  ids !== undefined && ids.length > 0
    ? {
        type: "UserAssigned" as const,
        userAssignedIdentities: Object.fromEntries(ids.map((id) => [id, {}])),
      }
    : { type: "None" as const };

/**
 * Re-raise a `ProvisioningFailed` with the error the service recorded on
 * the resource (`properties.errors`), which explains why it failed.
 */
export const withRecordedError =
  <E1, R1>(describe: Effect.Effect<string | undefined, E1, R1>) =>
  <A, E2, R>(self: Effect.Effect<A, E2 | ProvisioningFailed, R>) =>
    Effect.catchTag(
      self,
      "Azure.ProvisioningFailed",
      (failure: ProvisioningFailed) =>
        describe.pipe(
          Effect.orElseSucceed(() => undefined),
          Effect.flatMap((detail) =>
            Effect.fail(
              new ProvisioningFailed({
                ...failure,
                message:
                  detail === undefined
                    ? failure.message
                    : `${failure.message}: ${detail}`,
              }),
            ),
          ),
        ),
    );

export const lower = (value: string | undefined) => value?.toLowerCase();
