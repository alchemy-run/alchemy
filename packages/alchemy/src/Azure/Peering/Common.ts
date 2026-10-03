import * as peering from "@distilled.cloud/azure/peering";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/** Deterministic Microsoft.Peering resource name (letters, digits, `-`). */
export const createPeeringName = (id: string, maxLength = 63) =>
  createPhysicalName({ id, maxLength });

export const getPeeringService = (
  subscriptionId: string,
  resourceGroupName: string,
  peeringServiceName: string,
) =>
  orUndefinedIfNotFound(
    peering.GetPeeringService({
      subscriptionId,
      resourceGroupName,
      peeringServiceName,
    }),
  );

export const getPeering = (
  subscriptionId: string,
  resourceGroupName: string,
  peeringName: string,
) =>
  orUndefinedIfNotFound(
    peering.GetPeering({ subscriptionId, resourceGroupName, peeringName }),
  );

const taggedByStage = Effect.fn(function* (
  tags: Record<string, string | undefined> | undefined,
) {
  const { stack, stage } = yield* stackAndStage;
  return tags?.["alchemy::stack"] === stack && tags?.["alchemy::stage"] === stage;
});

/**
 * Children of a peering service (prefixes, connection monitor tests) have
 * no tags; they are owned when their peering service carries this
 * stack/stage's ownership tags.
 */
export const peeringServiceOwnedByStage = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  peeringServiceName: string,
) {
  const observed = yield* getPeeringService(
    subscriptionId,
    resourceGroupName,
    peeringServiceName,
  );
  return yield* taggedByStage(observed?.tags);
});

/**
 * Children of a peering (registered ASNs and prefixes) have no tags; they
 * are owned when their peering carries this stack/stage's ownership tags.
 */
export const peeringOwnedByStage = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  peeringName: string,
) {
  const observed = yield* getPeering(
    subscriptionId,
    resourceGroupName,
    peeringName,
  );
  return yield* taggedByStage(observed?.tags);
});
