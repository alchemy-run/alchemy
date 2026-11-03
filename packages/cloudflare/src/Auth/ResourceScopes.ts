import type { PreflightResource } from "alchemy/Auth/AuthProvider";
import { OAUTH_SCOPE_NAMES, type OAuthScopeId } from "./OAuthScopes.ts";

/**
 * The OAuth scope each resource type's create/update/delete calls need: any
 * one scope of the list is enough. Taken from the `x-api-token-group` that
 * Cloudflare's API schema (https://github.com/cloudflare/api-schemas) lists
 * for those endpoints, mapped to the scope with the same permission name in
 * {@link OAUTH_SCOPE_NAMES}. Types not listed here are not checked.
 */
export const RESOURCE_OAUTH_SCOPES: Readonly<Record<string, ReadonlyArray<OAuthScopeId>>> = {
  // Account- and zone-level apps and policies share one permission.
  "Cloudflare.Access.Application": ["access.write", "zone-access.write"],
  "Cloudflare.Access.Policy": ["access.write", "zone-access.write"],
  "Cloudflare.Access.Bookmark": ["access.write"],
  "Cloudflare.Access.Group": ["access-acct.write"],
  "Cloudflare.Access.IdentityProvider": ["access-acct.write"],
  "Cloudflare.Access.Organization": ["access-acct.write"],
  "Cloudflare.Access.ServiceToken": ["access-service-token.write"],
  "Cloudflare.Access.CustomPage": ["access-custom-page.write"],
  "Cloudflare.Access.Certificate": ["access-certificate.write"],
  "Cloudflare.Worker": ["workers-scripts.write"],
  "Cloudflare.Workflow": ["workers-scripts.write"],
  "Cloudflare.Workers.Route": ["workers-routes.write"],
  "Cloudflare.D1Database": ["d1.write"],
  "Cloudflare.R2.Bucket": ["workers-r2.write"],
  "Cloudflare.KV.Namespace": ["workers-kv-storage.write"],
  "Cloudflare.Queues.Queue": ["queues.write", "workers-scripts.write"],
  "Cloudflare.Hyperdrive": ["query-cache.write"],
  "Cloudflare.VectorizeIndex": ["vectorize.write"],
  "Cloudflare.SecretsStore": ["secrets-store.write"],
  "Cloudflare.DNS.Record": ["dns.write"],
  "Cloudflare.Tunnel.Tunnel": [
    "argotunnel.write",
    "teams-connectors.write",
    "teams-connector-cloudflared.write",
  ],
};

/** One scope a stack needs but the grant lacks. */
export interface MissingOAuthScope {
  /** The scope to grant; {@link alternatives} would do as well. */
  readonly scope: OAuthScopeId;
  readonly alternatives: ReadonlyArray<OAuthScopeId>;
  /** FQNs of the resources that need it. */
  readonly resources: ReadonlyArray<string>;
}

/** The scopes `resources` need that `granted` lacks, one entry per scope. */
export const missingOAuthScopes = (
  granted: ReadonlyArray<string>,
  resources: ReadonlyArray<PreflightResource>,
): MissingOAuthScope[] => {
  const grantedSet = new Set(granted);
  const missing = new Map<OAuthScopeId, { alternatives: OAuthScopeId[]; resources: string[] }>();
  for (const resource of resources) {
    const accepted = RESOURCE_OAUTH_SCOPES[resource.Type];
    if (accepted === undefined || accepted.some((scope) => grantedSet.has(scope))) continue;
    const [scope, ...alternatives] = accepted;
    if (scope === undefined) continue;
    const entry = missing.get(scope) ?? { alternatives, resources: [] };
    entry.resources.push(resource.FQN);
    missing.set(scope, entry);
  }
  return [...missing].map(([scope, entry]) => ({ scope, ...entry }));
};

/** The message for a grant missing `missing`, with the command that fixes it. */
export const missingOAuthScopesMessage = (
  profileName: string,
  missing: ReadonlyArray<MissingOAuthScope>,
  hint: string,
): string =>
  `Cloudflare: the OAuth grant of profile '${profileName}' lacks scopes this stack needs:\n` +
  missing
    .map(
      ({ scope, alternatives, resources }) =>
        `  - ${scope} (${OAUTH_SCOPE_NAMES[scope]})` +
        (alternatives.length > 0 ? ` or ${alternatives.join(", ")}` : "") +
        `: ${resources.join(", ")}`,
    )
    .join("\n") +
  `\n${hint} Choose All Scopes, or add these under Custom Scopes.`;
