import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import {
  createBackupName,
  isVaultOwnedByStack,
} from "../RecoveryServices/BackupShared.ts";

/** Resource provider namespace of Recovery Services vaults (and ASR). */
export const SITE_RECOVERY_NAMESPACE = "Microsoft.RecoveryServices";

/**
 * Deterministic name for an ASR object: letters, digits, and hyphens,
 * starting with a letter.
 */
export const createSiteRecoveryName = (id: string, maxLength = 60) =>
  createBackupName(id, maxLength);

/** Case-insensitive ARM ID / name equality. */
export const sameName = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/**
 * ASR objects cannot be tagged: they are owned when they are already in
 * state or their vault is tagged for the current stack and stage.
 */
export const ownedOrUnowned = <A extends object>(
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

/** Drop `undefined` fields so request bodies only carry what the user set. */
export const compact = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;
