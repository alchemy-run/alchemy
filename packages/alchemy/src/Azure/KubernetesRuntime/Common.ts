/**
 * Shared helpers for `Microsoft.KubernetesRuntime` resources. Not exported
 * from the namespace barrel.
 */
import { createPhysicalName } from "../../PhysicalName.ts";

/** The ARM `provisioningState` of a Microsoft.KubernetesRuntime resource. */
export const runtimeState = (value: {
  readonly properties?: { readonly provisioningState?: string };
}) => value.properties?.provisioningState;

/** Lowercased ARM id comparison (ARM echoes ids with mixed casing). */
export const sameId = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/** Order-insensitive string list comparison. */
export const sameList = (
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
) => [...(a ?? [])].sort().join("\n") === [...(b ?? [])].sort().join("\n");

/** String map comparison ignoring key order. */
export const sameMap = (
  a: Readonly<Record<string, string | undefined>> | undefined,
  b: Readonly<Record<string, string | undefined>> | undefined,
) => {
  const norm = (m: Readonly<Record<string, string | undefined>> | undefined) =>
    JSON.stringify(
      Object.entries(m ?? {})
        .filter(([, v]) => v !== undefined)
        .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
    );
  return norm(a) === norm(b);
};

/**
 * Default name for a KubernetesRuntime object: Azure allows
 * `^[a-zA-Z0-9-]{3,24}$`, and the object is materialised as a Kubernetes
 * object, so keep it lowercase.
 */
export const runtimeObjectName = (id: string) =>
  createPhysicalName({ id, maxLength: 24, lowercase: true, delimiter: "-" });

/**
 * Writes are proxied through Azure Arc to the cluster, so they converge in
 * the background; ~5 minutes.
 */
export const RUNTIME_WAIT = { interval: "5 seconds", times: 60 } as const;
