import {
  PERMISSION_GROUPS_BY_NAME,
  type PermissionGroupName,
} from "./PermissionGroups.ts";

/**
 * Resource keys recognized by Cloudflare API token policies.
 *
 * Cloudflare requires the account ID to be embedded directly in the resource
 * key (e.g. `com.cloudflare.api.account.<accountId>`); pass the fully-qualified
 * key — no rewriting is performed.
 *
 * @see https://developers.cloudflare.com/fundamentals/api/reference/permissions/
 */
export type ApiTokenResourceKey =
  | `com.cloudflare.api.account.${string}`
  | `com.cloudflare.api.account.zone.${string}`
  | `com.cloudflare.edge.r2.bucket.${string}`
  | (string & {});

/**
 * A permission group reference: either a typed Cloudflare permission-group
 * name (resolved against the static catalog) or an explicit `{ id }` for
 * names that aren't in the catalog or have multiple scopes.
 */
export type ApiTokenPermissionGroupRef =
  | PermissionGroupName
  | { id: string; meta?: { key?: string; value?: string } };

export interface ApiTokenPolicy {
  effect: "allow" | "deny";
  permissionGroups: ApiTokenPermissionGroupRef[];
  resources: { [K in ApiTokenResourceKey]?: string };
}

export interface ApiTokenCondition {
  requestIp?: {
    in?: string[];
    notIn?: string[];
  };
}

export type ApiTokenProps = {
  /**
   * Token name. Defaults to a generated physical name based on the
   * resource's logical id, app name, and stage.
   */
  name?: string;
  /**
   * The Cloudflare account ID that owns this token. Defaults to the
   * account ID resolved from the ambient {@link CloudflareEnvironment}.
   */
  accountId?: string;
  /**
   * Access policies attached to the token. At least one policy is required
   * by Cloudflare.
   */
  policies: ApiTokenPolicy[];
  /** ISO 8601 expiration timestamp. */
  expiresOn?: string;
  /** ISO 8601 "not before" timestamp. */
  notBefore?: string;
  /** Optional usage conditions (e.g. IP allowlist). */
  condition?: ApiTokenCondition;
};

export type ResolvedPolicy = {
  effect: "allow" | "deny";
  permissionGroups: { id: string; meta?: { key?: string; value?: string } }[];
  resources: Record<string, unknown>;
};

export const resolvePermissionGroup = (ref: ApiTokenPermissionGroupRef) => {
  if (typeof ref === "string") {
    const group = PERMISSION_GROUPS_BY_NAME[ref];
    if (!group) {
      // Should be unreachable due to the typed union, but guard anyway in
      // case Cloudflare retires a name we still have in the catalog.
      throw new Error(
        `Unknown Cloudflare permission group: "${ref}". Pass an explicit { id } instead.`,
      );
    }
    return { id: group.id };
  }
  return ref.meta ? { id: ref.id, meta: ref.meta } : { id: ref.id };
};

const resolveResources = (
  resources: ApiTokenPolicy["resources"],
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(resources)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
};

export const resolvePolicies = (
  policies: ApiTokenPolicy[],
): ResolvedPolicy[] =>
  policies.map((policy) => ({
    effect: policy.effect,
    permissionGroups: policy.permissionGroups.map(resolvePermissionGroup),
    resources: resolveResources(policy.resources),
  }));

export const policyFingerprint = (policies: ResolvedPolicy[]): string =>
  JSON.stringify(
    policies.map((p) => ({
      effect: p.effect,
      permissionGroups: [...p.permissionGroups]
        .map((g) => ({ id: g.id, meta: g.meta ?? null }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      resources: Object.keys(p.resources)
        .sort()
        .map((k) => [k, p.resources[k]]),
    })),
  );

export const conditionFingerprint = (
  condition: ApiTokenCondition | undefined,
): string =>
  JSON.stringify({
    in: [...(condition?.requestIp?.in ?? [])].sort(),
    notIn: [...(condition?.requestIp?.notIn ?? [])].sort(),
  });

export const buildConditionPayload = (
  condition: ApiTokenCondition | undefined,
) =>
  condition
    ? {
        requestIp: condition.requestIp
          ? {
              in: condition.requestIp.in,
              notIn: condition.requestIp.notIn,
            }
          : undefined,
      }
    : undefined;
