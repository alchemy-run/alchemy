import type {
  ProviderMetadataIndex,
  StackProviderMetadata,
} from "../../Provider.ts";
import type { OAuthScope } from "./AuthProvider.ts";

/**
 * Cloud-specific analysis of {@link StackProviderMetadata} for Cloudflare —
 * the union of what the stack's Cloudflare resources require from a
 * credential. Consumed by `alchemy login` (OAuth scope preselection),
 * `alchemy cloudflare create-token --from-stack` (least-privilege token
 * minting), and the deploy preflight.
 *
 * Every entry carries the resource types that demanded it so prompts and
 * warnings can explain *why* a grant is needed.
 */
export interface CloudflareRequirements {
  /** OAuth scope → resource types requiring it (full lifecycle). */
  oauthScopes: Map<OAuthScope, string[]>;
  /**
   * Resource types whose full lifecycle cannot run on an OAuth user token
   * (`metadata.cloudflare.auth.oauth.supported === false`) — they need an
   * API token.
   */
  oauthUnsupported: string[];
  /** Permission-group id → name + resource types requiring it. */
  permissionGroups: Map<string, { name: string; resourceTypes: string[] }>;
  /** True when any zone-scoped resource is present. */
  hasZoneScoped: boolean;
}

const push = <K>(map: Map<K, string[]>, key: K, resourceType: string) => {
  const list = map.get(key);
  if (list) list.push(resourceType);
  else map.set(key, [resourceType]);
};

/**
 * Union the `cloudflare` metadata namespaces across the given index. Prefers
 * the exact-mode `used` subset; falls back to `all` (whole-cloud — over-asks)
 * when the stack couldn't be compiled.
 */
export const collectCloudflareRequirements = (
  metadata: StackProviderMetadata,
): CloudflareRequirements => {
  const index: ProviderMetadataIndex = metadata.used ?? metadata.all;
  const requirements: CloudflareRequirements = {
    oauthScopes: new Map(),
    oauthUnsupported: [],
    permissionGroups: new Map(),
    hasZoneScoped: false,
  };
  for (const [resourceType, entry] of index) {
    const cloudflare = entry.cloudflare;
    if (cloudflare === undefined) continue;
    if (cloudflare.scope === "zone") {
      requirements.hasZoneScoped = true;
    }
    const oauth = cloudflare.auth?.oauth;
    if (oauth?.supported === false) {
      requirements.oauthUnsupported.push(resourceType);
    }
    for (const scope of oauth?.scopes ?? []) {
      push(requirements.oauthScopes, scope, resourceType);
    }
    const token = cloudflare.auth?.token;
    for (const group of token?.permissionGroups ?? []) {
      const existing = requirements.permissionGroups.get(group.id);
      if (existing) existing.resourceTypes.push(resourceType);
      else
        requirements.permissionGroups.set(group.id, {
          name: group.name,
          resourceTypes: [resourceType],
        });
    }
  }
  requirements.oauthUnsupported.sort();
  return requirements;
};

/**
 * Base scopes every profile needs regardless of resources: account/user
 * enumeration for configure, plus zone listing when zone-scoped resources
 * are present.
 */
export const suggestOAuthScopes = (
  requirements: CloudflareRequirements,
): OAuthScope[] => {
  const scopes = new Set<OAuthScope>(["account:read", "user:read"]);
  if (requirements.hasZoneScoped) {
    scopes.add("zone:read");
  }
  for (const scope of requirements.oauthScopes.keys()) {
    scopes.add(scope);
  }
  return [...scopes].sort();
};
