/**
 * Shared helpers for `Microsoft.Edge` resources. Not exported from the
 * namespace barrel.
 */

/** The ARM `provisioningState` of a Microsoft.Edge resource. */
export const edgeState = (value: {
  readonly properties?: { readonly provisioningState?: string };
}) => value.properties?.provisioningState;

/**
 * Structural equality for plain JSON values with object keys compared in
 * sorted order (capability lists, hierarchy lists, specifications).
 */
export const sameJson = (a: unknown, b: unknown): boolean =>
  canonical(a) === canonical(b);

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([, x]) => x !== undefined)
            .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
        )
      : v,
  ) ?? "undefined";

/** Lowercased ARM id comparison (ARM echoes ids with mixed casing). */
export const sameId = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/** Long-running Microsoft.Edge PUT/DELETE poll budget (~2 minutes). */
export const EDGE_WAIT = { interval: "3 seconds", times: 40 } as const;
