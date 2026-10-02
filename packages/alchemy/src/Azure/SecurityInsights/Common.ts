import * as Effect from "effect/Effect";
import { ownershipMarker } from "../LogAnalytics/Common.ts";

export {
  deterministicGuid,
  isWorkspaceOwnedByStack,
  ownershipMarker,
  sameText,
  stripMarker,
  withMarker,
} from "../LogAnalytics/Common.ts";

/** Resource provider namespace of Microsoft Sentinel. */
export const SENTINEL_NAMESPACE = "Microsoft.SecurityInsights";

/** Drop `undefined` fields so a PUT body and the observed state compare cleanly. */
export const compact = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (
    typeof a === "object" &&
    typeof b === "object" &&
    a !== null &&
    b !== null &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    return subsetEqual(a as Record<string, unknown>, b as Record<string, unknown>);
  }
  return false;
};

/**
 * Whether every field set in `desired` has the same value in `observed`.
 * Fields the service adds (timestamps, defaults) are ignored; `undefined`
 * desired fields are skipped.
 */
export const subsetEqual = (
  desired: Record<string, unknown>,
  observed: Record<string, unknown> | undefined,
): boolean =>
  observed !== undefined &&
  Object.entries(desired).every(
    ([key, value]) => value === undefined || deepEqual(value, observed[key]),
  );

/** Whether a description carries this stack/stage/id's ownership marker. */
export const hasOwnMarker = Effect.fn(function* (
  id: string,
  description: string | undefined,
) {
  const marker = yield* ownershipMarker(id);
  return (description ?? "").endsWith(marker);
});
