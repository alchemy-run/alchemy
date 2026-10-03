import * as elasticsan from "@distilled.cloud/azure/elasticsan";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/**
 * Elastic SAN names (SANs, volume groups, volumes, snapshots): lowercase
 * letters, digits, hyphens and underscores, starting and ending with a
 * letter or digit, no consecutive separators.
 */
export const createSanName = Effect.fn(function* (
  id: string,
  maxLength: number,
) {
  const name = yield* createPhysicalName({
    id,
    maxLength,
    lowercase: true,
    delimiter: "-",
  });
  return name.replace(/-+/g, "-").replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
});

export const getElasticSan = (
  subscriptionId: string,
  resourceGroupName: string,
  elasticSanName: string,
) =>
  orUndefinedIfNotFound(
    elasticsan.GetElasticSan({
      subscriptionId,
      resourceGroupName,
      elasticSanName,
    }),
  );

/**
 * Volume groups, volumes and snapshots carry no tags or metadata, so their
 * ownership follows the parent Elastic SAN: owned when the SAN carries this
 * stack's and stage's Alchemy tags.
 */
export const isParentOwned = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  elasticSanName: string,
) {
  const san = yield* getElasticSan(
    subscriptionId,
    resourceGroupName,
    elasticSanName,
  );
  const { stack, stage } = yield* stackAndStage;
  return (
    san?.tags?.["alchemy::stack"] === stack &&
    san?.tags?.["alchemy::stage"] === stage
  );
});

export const lower = (value: string | undefined) => value?.toLowerCase();
