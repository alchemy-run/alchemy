import * as dr from "@distilled.cloud/azure/recoveryservicesdatareplication";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/** Resource provider namespace of Azure Site Recovery data replication. */
export const DATA_REPLICATION_NAMESPACE = "Microsoft.DataReplication";

/**
 * Deterministic name for a data replication object: every name in this
 * API (vaults, fabrics, agents, policies, extensions, protected items)
 * must match `^[a-zA-Z0-9]*$`.
 */
export const createDataReplicationName = (id: string, maxLength = 40) =>
  createPhysicalName({ id, maxLength, lowercase: true, delimiter: "" }).pipe(
    Effect.map((name) => name.replace(/[^a-z0-9]/g, "")),
  );

/** Case-insensitive ARM ID / name equality. */
export const sameName = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/** Whether the vault is tagged as owned by the current stack and stage. */
export const isVaultOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
) {
  const vault = yield* orUndefinedIfNotFound(
    dr.GetVault({ subscriptionId, resourceGroupName, vaultName }),
  );
  if (vault === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  const tags = tagRecord(vault.tags);
  return tags["alchemy::stack"] === stack && tags["alchemy::stage"] === stage;
});

/** Whether the fabric is tagged as owned by the current stack and stage. */
export const isFabricOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  fabricName: string,
) {
  const fabric = yield* orUndefinedIfNotFound(
    dr.GetFabric({ subscriptionId, resourceGroupName, fabricName }),
  );
  if (fabric === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  const tags = tagRecord(fabric.tags);
  return tags["alchemy::stack"] === stack && tags["alchemy::stage"] === stage;
});

/**
 * Vault children cannot be tagged: they are owned when they are already in
 * state or their vault is tagged for the current stack and stage.
 */
export const ownedByVaultOrUnowned = <A extends object>(
  attrs: A,
  inState: boolean,
  subscriptionId: string,
  resourceGroup: string,
  vault: string,
) =>
  Effect.gen(function* () {
    if (inState) return attrs;
    return (yield* isVaultOwnedByStack(subscriptionId, resourceGroup, vault))
      ? attrs
      : Unowned(attrs);
  });

/**
 * Whether every field set in `desired` has the same value in `observed`
 * (fields the service fills in are ignored). Strings compare
 * case-insensitively; arrays element-wise.
 */
export const matchesDesired = (
  observed: unknown,
  desired: unknown,
): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      observed.length === desired.length &&
      desired.every((item, i) => matchesDesired(observed[i], item))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    return Object.entries(desired).every(([key, value]) =>
      matchesDesired((observed as Record<string, unknown>)[key], value),
    );
  }
  if (typeof desired === "string" && typeof observed === "string") {
    return desired.toLowerCase() === observed.toLowerCase();
  }
  return observed === desired;
};

/**
 * Polymorphic `customProperties` payload of a data replication object: an
 * `instanceType` discriminator plus the fields of that subtype.
 */
export interface DataReplicationCustomProperties {
  /** Discriminator, e.g. `HyperVToAzStackHCI` or `VMwareToAzStackHCI`. */
  instanceType: string;
  /** Subtype fields, sent verbatim. */
  [field: string]: unknown;
}
