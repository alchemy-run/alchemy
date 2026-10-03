/**
 * Shared helpers for `Microsoft.HybridContainerService` (AKS Arc) resources.
 * Not exported from the namespace barrel.
 */

/** Resource provider namespace of AKS enabled by Azure Arc. */
export const HYBRID_AKS_NAMESPACE = "Microsoft.HybridContainerService";

/**
 * Arc custom location of the Azure Local (Azure Stack HCI) cluster that
 * hosts AKS Arc resources. Backed by the Arc Resource Bridge.
 */
export interface HybridAksExtendedLocation {
  /** ARM ID of the `Microsoft.ExtendedLocation/customLocations` resource. */
  name: string;
  /**
   * Extended location type.
   * @default "CustomLocation"
   */
  type?: "CustomLocation";
}

/** The request body form of an extended location. */
export const toExtendedLocation = (location: HybridAksExtendedLocation) => ({
  name: location.name,
  type: location.type ?? "CustomLocation",
});

/** Lowercased ARM ID / name comparison (ARM echoes IDs with mixed casing). */
export const sameId = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .sort()
        .map((key) => [
          key,
          canonical((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  return value;
};

/** Structural equality of plain prop values (key order and `undefined` ignored). */
export const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * Whether every value the user specified in `desired` is reflected in
 * `observed`. Keys left `undefined` in `desired` are service defaults and
 * never count as drift. Arrays and scalars must match exactly.
 */
export const matchesDesired = (
  desired: unknown,
  observed: unknown,
): boolean => {
  if (desired === undefined) return true;
  if (
    desired !== null &&
    typeof desired === "object" &&
    !Array.isArray(desired)
  ) {
    if (observed === null || typeof observed !== "object") return false;
    return Object.entries(desired as Record<string, unknown>).every(
      ([key, value]) =>
        matchesDesired(value, (observed as Record<string, unknown>)[key]),
    );
  }
  return sameValue(desired, observed);
};

/**
 * AKS Arc clusters and node pools provision VMs on the Azure Local hosts;
 * creates and upgrades take ~10-30 minutes.
 */
export const CLUSTER_WAIT = { interval: "30 seconds", times: 60 } as const;
