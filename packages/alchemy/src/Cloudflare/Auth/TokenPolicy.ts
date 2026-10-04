/**
 * Cloudflare expresses an API token's grants as *policies*: one entry per
 * resource scope, each listing the permission groups allowed on it. The
 * catalog hands back a flat list of permission groups, so minting a token
 * means bucketing those groups by the scope they belong to.
 */

/**
 * One `{effect, permissionGroups, resources}` entry in a token's policy list.
 * Mutable to match the shape Cloudflare's create-token request expects.
 */
export interface TokenPolicy {
  effect: "allow";
  permissionGroups: Array<{ id: string }>;
  resources: Record<string, string | Record<string, string>>;
}

/** A permission group as returned by Cloudflare's token-permissions catalog. */
export interface PermissionGroup {
  readonly id: string;
  readonly name: string;
  readonly category?: string;
  readonly scopes: ReadonlyArray<string>;
  /** Whether this group's scope maps onto a policy we know how to express. */
  readonly selectable: boolean;
}

/** Scopes we know how to turn into a policy; anything else is not offerable. */
export const selectableScopes: ReadonlySet<string> = new Set([
  "com.cloudflare.api.account",
  "com.cloudflare.api.account.zone",
  "com.cloudflare.api.user",
  "com.cloudflare.edge.r2.bucket",
]);

/**
 * Permission groups no scope on Alchemy's OAuth client covers; Cloudflare
 * rejects an OAuth-minted token that requests any of them. "Workers Admin"
 * needs `workers-scripts.admin`, which the client doesn't have; the rest have
 * no scope at all in https://api.cloudflare.com/client/v4/oauth/scopes.
 */
export const OAUTH_UNGRANTABLE_PERMISSION_GROUPS: ReadonlySet<string> = new Set([
  "Billing Read",
  "Billing Write",
  "OAuth Client Read",
  "OAuth Client Write",
  "Rule Policies Read",
  "Rule Policies Write",
  "SSO Connector Read",
  "SSO Connector Write",
  "Workers Admin",
]);

/** Cloudflare rejects a policy listing more permission groups than this. */
const MAX_POLICY_PERMISSION_GROUPS = 300;

/**
 * Bucket permission groups by resource scope into Cloudflare's policy shape.
 * Groups whose scope has no known bucket are dropped — they cannot be granted.
 */
export const tokenPolicies = (
  accountIds: ReadonlyArray<string>,
  userId: string | undefined,
  groups: ReadonlyArray<PermissionGroup>,
): TokenPolicy[] => {
  const perAccount = (resources: string | Record<string, string>) =>
    Object.fromEntries(accountIds.map((id) => [`com.cloudflare.api.account.${id}`, resources]));
  const buckets: Record<string, TokenPolicy> = {
    "com.cloudflare.api.account": {
      effect: "allow",
      permissionGroups: [],
      resources: perAccount("*"),
    },
    "com.cloudflare.api.account.zone": {
      effect: "allow",
      permissionGroups: [],
      resources: perAccount({ "com.cloudflare.api.account.zone.*": "*" }),
    },
    "com.cloudflare.edge.r2.bucket": {
      effect: "allow",
      permissionGroups: [],
      resources: perAccount("*"),
    },
    ...(userId === undefined
      ? {}
      : {
          "com.cloudflare.api.user": {
            effect: "allow" as const,
            permissionGroups: [],
            resources: { [`com.cloudflare.api.user.${userId}`]: "*" },
          },
        }),
  };
  const seen = new Set<string>();
  for (const group of groups) {
    const bucket = buckets[group.scopes[0]!];
    if (bucket === undefined || seen.has(group.id)) continue;
    seen.add(group.id);
    bucket.permissionGroups.push({ id: group.id });
  }
  return Object.values(buckets).flatMap((policy) =>
    Array.from(
      { length: Math.ceil(policy.permissionGroups.length / MAX_POLICY_PERMISSION_GROUPS) },
      (_, i) => ({
        ...policy,
        permissionGroups: policy.permissionGroups.slice(
          i * MAX_POLICY_PERMISSION_GROUPS,
          (i + 1) * MAX_POLICY_PERMISSION_GROUPS,
        ),
      }),
    ),
  );
};
