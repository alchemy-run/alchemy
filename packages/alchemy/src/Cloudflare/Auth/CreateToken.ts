import { apiKeyCredentials } from "@distilled.cloud/cloudflare/Credentials";
import * as user from "@distilled.cloud/cloudflare/user";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as CloudflareCredentials from "../Credentials.ts";

/**
 * Shared machinery for minting Cloudflare API tokens (`POST /user/tokens`),
 * used by both `alchemy cloudflare create-token` and the token-creation path
 * inside `alchemy login --configure`.
 *
 * Minting always authenticates with the account's **Global API Key**:
 * Cloudflare only mints a token whose permissions the authenticating
 * credential is allowed to grant, and OAuth/scoped tokens silently produce a
 * token with zero permissions. The key is used only to create the token and
 * is never stored.
 */

export interface GlobalKeyAuth {
  apiKey: string;
  email: string;
}

export interface LivePermissionGroup {
  id: string;
  name: string;
  scopes: string[];
}

/**
 * A single resolved Cloudflare token policy in the shape expected by
 * `POST /user/tokens`.
 */
export type CreateTokenPolicy = {
  effect: "allow";
  permissionGroups: { id: string }[];
  resources: Record<string, unknown>;
};

/**
 * Cloudflare scopes that {@link buildTokenPolicies} knows how to turn into a
 * policy, mapped to a short human label shown as a hint in selection prompts.
 * Groups with any other scope cannot be expressed as a policy.
 */
export const SELECTABLE_SCOPE_LABELS: Record<string, string> = {
  "com.cloudflare.api.account": "account",
  "com.cloudflare.api.account.zone": "zone",
  "com.cloudflare.edge.r2.bucket": "r2",
};

/**
 * Resolve permission groups live from Cloudflare instead of a static catalog.
 * Cloudflare silently ignores permission-group IDs it doesn't recognize, so a
 * stale local list yields a token with zero permissions.
 * `/user/tokens/permission_groups` returns exactly the groups (and IDs) valid
 * for this credential.
 *
 * Hits the endpoint with a raw GET rather than the typed distilled client:
 * the client hard-codes the set of valid `scopes` literals, and Cloudflare
 * keeps adding new ones (e.g. `com.cloudflare.edge.worker.script`), which
 * makes the strict schema reject the whole response. Parsing leniently keeps
 * us forward-compatible.
 */
export const fetchLivePermissionGroups = (auth: GlobalKeyAuth) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.get(
      "https://api.cloudflare.com/client/v4/user/tokens/permission_groups",
      {
        headers: {
          "X-Auth-Key": auth.apiKey,
          "X-Auth-Email": auth.email,
          Accept: "application/json",
        },
      },
    );
    const body = (yield* response.json) as {
      result?: { id?: string; name?: string; scopes?: string[] }[];
    };
    return (body.result ?? []).flatMap((g) =>
      g.id && g.scopes && g.scopes.length > 0
        ? [{ id: g.id, name: g.name ?? "", scopes: g.scopes }]
        : [],
    );
  });

/**
 * Group permission groups by their Cloudflare scope and produce one policy
 * per scope, wiring up the right resource selector for each:
 *
 * - `com.cloudflare.api.account` → scoped to each selected account ID
 * - `com.cloudflare.api.account.zone` → all zones (`*`)
 * - `com.cloudflare.edge.r2.bucket` → all buckets (`*`)
 *
 * Mirrors the upstream `alchemy` "god token" policy shape. Groups with an
 * unrecognized scope are skipped, and empty policies are dropped. When more
 * than one account is selected, the account-scoped policy lists every chosen
 * account in its `resources` map so the token spans all of them.
 */
export const buildTokenPolicies = (
  accountIds: readonly string[],
  groups: readonly { id: string; scopes: readonly string[] }[],
): CreateTokenPolicy[] => {
  const buckets: Record<string, CreateTokenPolicy> = {
    "com.cloudflare.api.account": {
      effect: "allow",
      permissionGroups: [],
      resources: Object.fromEntries(
        accountIds.map((id) => [`com.cloudflare.api.account.${id}`, "*"]),
      ),
    },
    "com.cloudflare.api.account.zone": {
      effect: "allow",
      permissionGroups: [],
      resources: { "com.cloudflare.api.account.zone.*": "*" },
    },
    "com.cloudflare.edge.r2.bucket": {
      effect: "allow",
      permissionGroups: [],
      resources: { "com.cloudflare.edge.r2.bucket.*": "*" },
    },
  };
  const seen = new Set<string>();
  for (const group of groups) {
    const bucket = buckets[group.scopes[0]!];
    if (!bucket || seen.has(group.id)) continue;
    seen.add(group.id);
    bucket.permissionGroups.push({ id: group.id });
  }
  return Object.values(buckets).filter((p) => p.permissionGroups.length > 0);
};

/**
 * Resolve the permission groups a stack requires (from provider metadata)
 * against the live list — by id first, then by (unique) name as a fallback
 * for retired/renamed ids. Anything unresolvable is reported in `missing`
 * rather than silently dropped.
 */
export const resolveRequiredGroups = (
  required: ReadonlyMap<string, { name: string; resourceTypes: string[] }>,
  live: LivePermissionGroup[],
): { selected: LivePermissionGroup[]; missing: string[] } => {
  const byId = new Map(live.map((g) => [g.id, g]));
  const byName = new Map(live.map((g) => [g.name, g]));
  const selected: LivePermissionGroup[] = [];
  const missing: string[] = [];
  for (const [id, info] of required) {
    const match = byId.get(id) ?? byName.get(info.name);
    if (match) {
      selected.push(match);
    } else {
      missing.push(
        `${info.name} (${id}) — needed by ${info.resourceTypes.join(", ")}`,
      );
    }
  }
  return { selected, missing };
};

export interface MintedToken {
  /** The token secret. Cloudflare only returns it once. */
  value: string | undefined;
  id: string | undefined;
  name: string | undefined;
  /**
   * Permission groups Cloudflare actually granted. It silently drops groups
   * the authenticating user isn't allowed to grant, so a token can come back
   * with zero permissions even though the request was well-formed (almost
   * always an account-role problem).
   */
  granted: number;
  policiesCount: number;
  /** Live `/user/tokens/verify` status of the minted token, if reachable. */
  status: string | undefined;
}

/**
 * Create the token and verify it authenticates. The Cloudflare dashboard has
 * a long-standing rendering bug where API-created tokens show a blank
 * permission summary, so a live `/user/tokens/verify` is the source of truth.
 */
export const mintToken = (options: {
  auth: GlobalKeyAuth;
  name: string;
  policies: CreateTokenPolicy[];
}) =>
  Effect.gen(function* () {
    const result = yield* user
      .createToken({ name: options.name, policies: options.policies })
      .pipe(
        Effect.provideService(
          CloudflareCredentials.Credentials,
          Effect.succeed(apiKeyCredentials(options.auth)),
        ),
      );

    const granted = (result.policies ?? []).reduce(
      (n, p) => n + (p.permissionGroups?.length ?? 0),
      0,
    );

    const http = yield* HttpClient.HttpClient;
    const status = result.value
      ? yield* http
          .get("https://api.cloudflare.com/client/v4/user/tokens/verify", {
            headers: {
              Authorization: `Bearer ${result.value}`,
              Accept: "application/json",
            },
          })
          .pipe(
            Effect.flatMap((r) => r.json),
            Effect.map(
              (b) => (b as { result?: { status?: string } }).result?.status,
            ),
            Effect.catch(() => Effect.succeed(undefined)),
          )
      : undefined;

    return {
      value: result.value ?? undefined,
      id: result.id ?? undefined,
      name: result.name ?? undefined,
      granted,
      policiesCount: result.policies?.length ?? 0,
      status,
    } satisfies MintedToken;
  });
