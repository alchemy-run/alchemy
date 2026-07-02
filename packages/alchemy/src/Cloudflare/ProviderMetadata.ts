import type { PermissionGroupName } from "./ApiToken/PermissionGroups.ts";
import type { OAuthScope } from "./Auth/AuthProvider.ts";

/**
 * A permission-group requirement. The `id` is authoritative — it is what token
 * policies actually consume, and it disambiguates names that exist at both
 * account and zone scope (e.g. "Logs Read"). The `name` is carried for
 * docs/UX and typed against the static catalog in
 * `ApiToken/PermissionGroups.ts` — if Cloudflare ships a group the catalog
 * doesn't know yet, add it to the catalog first.
 */
export interface PermissionGroupRequirement {
  id: string;
  name: PermissionGroupName;
}

/**
 * Credential requirements a Cloudflare resource provider declares via
 * `metadata.cloudflare`. Consumed by `alchemy login` (OAuth scope
 * preselection), `alchemy cloudflare create-token` (minting a least-privilege
 * API token for a stack), and deploy-time preflight (required-vs-granted
 * diffing). See `processes/ProviderMetadata/DESIGN.md`.
 *
 * Values must be plain literals — no `Output`s, Effects, or environment reads.
 */
export interface CloudflareProviderMetadata {
  /**
   * The scope the resource lives at. Drives the token policy resource clause
   * (`com.cloudflare.api.account.*` vs `...account.zone.*`) and is surfaced
   * in generated docs.
   */
  scope?: "account" | "zone" | "user";
  auth?: {
    /**
     * Requirements when authenticating with an OAuth user token
     * (`alchemy login` → dash.cloudflare.com OAuth flow).
     */
    oauth?: {
      /**
       * Whether the full lifecycle (reconcile/delete) is possible with an
       * OAuth user token at all. Many products (most zone-level settings,
       * Magic Transit, Registrar, …) have no OAuth scope — set `false` and
       * `alchemy login` will steer the user to an API token.
       * @default true
       */
      supported?: boolean;
      /** OAuth scopes required for the full lifecycle, e.g. `"workers:write"`. */
      scopes?: OAuthScope[];
      /**
       * Narrower set sufficient for read/list/diff (plan-only sessions).
       * @default scopes
       */
      readScopes?: OAuthScope[];
    };
    /**
     * Requirements when authenticating with a Cloudflare API token, expressed
     * as permission groups. Each entry carries both the catalog `id`
     * (authoritative, consumed by token policies) and the human `name`.
     */
    token?: {
      /** Permission groups required for the full lifecycle. */
      permissionGroups?: PermissionGroupRequirement[];
      /**
       * Narrower set sufficient for read/list/diff.
       * @default permissionGroups
       */
      readPermissionGroups?: PermissionGroupRequirement[];
    };
  };
}

declare module "../Provider.ts" {
  interface AlchemyProviderMetadata {
    cloudflare?: CloudflareProviderMetadata;
  }
}
