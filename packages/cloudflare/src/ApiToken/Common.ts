import type { TokensCreateRequestPoliciesItemPermissionGroupsItemMeta } from "@distilled.cloud/cloudflare/accounts";
import {
  PERMISSION_GROUPS,
  type PermissionGroup,
  type PermissionGroupName,
} from "./PermissionGroups.ts";

/**
 * Resource keys recognized by Cloudflare API token policies.
 *
 * Cloudflare requires the account ID to be embedded directly in the resource
 * key (e.g. `com.cloudflare.api.account.<accountId>`); pass the fully-qualified
 * key — no rewriting is performed.
 *
 * Individual-Worker roles (e.g. `"Individual Workers Editor"`) take a
 * `com.cloudflare.edge.worker.script.<workerId>` key, where `<workerId>` is the
 * Worker's script tag (the Worker's `workerId` attribute). Cloudflare only
 * accepts it nested under the account key, and only on account-owned tokens.
 *
 * @see https://developers.cloudflare.com/fundamentals/api/reference/permissions/
 */
export type ResourceKey =
  | `com.cloudflare.api.account.${string}`
  | `com.cloudflare.api.account.zone.${string}`
  | `com.cloudflare.edge.r2.bucket.${string}`
  | `com.cloudflare.edge.worker.script.${string}`
  | (string & {});

/**
 * A permission group reference: either a typed Cloudflare permission-group
 * name (resolved against the static catalog) or an explicit `{ id }` for
 * names that aren't in the catalog. A name that Cloudflare gives to groups in
 * more than one scope (e.g. an account-scoped and a zone-scoped
 * `"Access: Apps and Policies Write"`) is resolved against the resource keys
 * of the policy it appears in; if those keys don't single out one group, pass
 * the group's `{ id }`.
 */
export type PermissionGroupRef = PermissionGroupName | { id: string; meta?: PermissionGroupMeta };

/**
 * Descriptive attributes of a permission group, as Cloudflare documents them
 * on token policies. Optional; Cloudflare does not store them on the token.
 */
export type PermissionGroupMeta = TokensCreateRequestPoliciesItemPermissionGroupsItemMeta;

/**
 * Value of a resource entry in an {@link Policy}. Usually `"*"`, but
 * account-owned tokens must nest zone resources under the account resource —
 * e.g. `{ "com.cloudflare.api.account.<id>": { "com.cloudflare.api.account.zone.*": "*" } }`
 * — so a nested object is also allowed.
 */
export type ResourceScope = string | { [K in ResourceKey]?: string };

export interface Policy {
  effect: "allow" | "deny";
  permissionGroups: PermissionGroupRef[];
  resources: { [K in ResourceKey]?: ResourceScope };
}

export interface Condition {
  requestIp?: {
    in?: string[];
    notIn?: string[];
  };
}

export type Props = {
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
   * Access policies attached to the token. Cloudflare requires at least one
   * policy on a token; if you omit `policies` here, the policies must instead
   * be contributed by bindings (see {@link ApiTokenBinding}).
   */
  policies?: Policy[];
  /** ISO 8601 expiration timestamp. */
  expiresOn?: string;
  /** ISO 8601 "not before" timestamp. */
  notBefore?: string;
  /** Optional usage conditions (e.g. IP allowlist). */
  condition?: Condition;
};

/**
 * Binding contract for {@link AccountApiToken} / {@link UserApiToken}.
 *
 * A binding contributes additional access policies to the token. This lets a
 * downstream resource (e.g. a runtime capability that needs to call a specific
 * Cloudflare API) create a token and attach exactly the policies it requires,
 * without the token's owner having to enumerate them up front.
 *
 * Binding-contributed policies are merged with any `policies` passed directly
 * as props; the union must contain at least one policy.
 */
export type ApiTokenBinding = {
  /** Access policies to attach to the token. */
  policies?: Policy[];
};

/**
 * Collect the policies a token should be created with: those passed directly
 * as props, plus those contributed by bindings.
 */
export const collectPolicies = (
  props: Policy[] | undefined,
  bindings: { data: ApiTokenBinding }[],
): Policy[] => [...(props ?? []), ...bindings.flatMap((binding) => binding.data.policies ?? [])];

export type ResolvedPolicy = {
  effect: "allow" | "deny";
  permissionGroups: { id: string; meta?: PermissionGroupMeta }[];
  resources: Record<string, ResourceScope>;
};

const keyMatchesScope = (key: string, scope: string) =>
  key === scope || key.startsWith(`${scope}.`);

/**
 * Pick the one group named `name` whose scope covers the policy's resources.
 * A nested resource (a zone key under an account key) is the target of the
 * policy, so it is matched instead of the key that holds it.
 */
const resolveSharedName = (
  name: string,
  candidates: PermissionGroup[],
  resources: Record<string, ResourceScope>,
): PermissionGroup => {
  const scopes = candidates.flatMap((group) => group.scopes);
  const targets = Object.entries(resources).flatMap(([key, value]) =>
    typeof value === "string" ? [key] : Object.keys(value),
  );
  // `com.cloudflare.api.account.zone.*` also starts with the account scope, so
  // each key counts for its longest matching scope only.
  const matched = new Set(
    targets.flatMap((key) => {
      const scope = scopes
        .filter((candidate) => keyMatchesScope(key, candidate))
        .sort((a, b) => b.length - a.length)[0];
      return scope === undefined ? [] : [scope];
    }),
  );
  const hits = candidates.filter((group) => group.scopes.some((scope) => matched.has(scope)));
  if (hits.length === 1) return hits[0]!;
  throw new Error(
    `Cloudflare permission group "${name}" exists in more than one scope ` +
      `(${candidates.map((group) => `${group.scopes.join(" + ")}: ${group.id}`).join("; ")}) ` +
      "and this policy's resources don't single out one. Pass an explicit { id } instead.",
  );
};

export const resolvePermissionGroup = (
  ref: PermissionGroupRef,
  resources: Record<string, ResourceScope> = {},
) => {
  if (typeof ref === "string") {
    const candidates = PERMISSION_GROUPS.filter((group) => group.name === ref);
    if (candidates.length === 0) {
      // Should be unreachable due to the typed union, but guard anyway in
      // case Cloudflare retires a name we still have in the catalog.
      throw new Error(
        `Unknown Cloudflare permission group: "${ref}". Pass an explicit { id } instead.`,
      );
    }
    const group =
      candidates.length === 1 ? candidates[0]! : resolveSharedName(ref, candidates, resources);
    return { id: group.id };
  }
  return ref.meta ? { id: ref.id, meta: ref.meta } : { id: ref.id };
};

const resolveResources = (resources: Policy["resources"]): Record<string, ResourceScope> => {
  const out: Record<string, ResourceScope> = {};
  for (const [key, value] of Object.entries(resources)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
};

export const resolvePolicies = (policies: Policy[]): ResolvedPolicy[] =>
  policies.map((policy) => {
    const resources = resolveResources(policy.resources);
    return {
      effect: policy.effect,
      permissionGroups: policy.permissionGroups.map((ref) =>
        resolvePermissionGroup(ref, resources),
      ),
      resources,
    };
  });

/**
 * Find a `com.cloudflare.edge.worker.script.*` key placed at the top level of
 * a policy's resources. Cloudflare answers those with a 500 that distilled
 * retries indefinitely, so callers reject them up front.
 */
export const findTopLevelWorkerScriptKey = (policies: ResolvedPolicy[]): string | undefined =>
  policies
    .flatMap((policy) => Object.keys(policy.resources))
    .find((key) => key.startsWith("com.cloudflare.edge.worker.script."));

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

export const conditionFingerprint = (condition: Condition | undefined): string =>
  JSON.stringify({
    in: [...(condition?.requestIp?.in ?? [])].sort(),
    notIn: [...(condition?.requestIp?.notIn ?? [])].sort(),
  });

export const buildConditionPayload = (condition: Condition | undefined) =>
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
