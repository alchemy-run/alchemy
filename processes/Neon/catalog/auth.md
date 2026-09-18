# Managed Auth and independently owned Auth configuration

Initial status: **missing** for Neon.Auth, Neon.AuthOAuthProvider and Neon.AuthTrustedDomain. Existing `Neon/AuthProvider.ts` is deployment credential resolution, not managed Better Auth. Gate set G0–G5, G9–G10. No Auth user/session account IaC is added.

## Files

`packages/alchemy/src/Neon/{Auth,AuthOAuthProvider,AuthTrustedDomain}.ts`, minimal Providers/index registration, live tests `packages/alchemy/test/Neon/{Auth,AuthOAuthProvider,AuthTrustedDomain}.test.ts` with suite-owned browser/runtime fixtures. ConnectAuth is specified in `bindings.md`.

## Auth contract

| Prop | Type/default | Rule |
| --- | --- | --- |
| branch or project | exclusive common scope | Scope change replaces; supplied scope is not owned. |
| database | optional database name | Select integration database on creation; database change replaces because config PATCH does not expose it. Defaults to project default database. |
| settings.name | optional display name | `updateNeonAuthConfig` accepts name. |
| emailAndPassword | optional object matching supported flags | enabled, verification method, require verification, auto sign-in, send verification on signup/signin, disable signup; compare observed config. |
| emailProvider | optional supported provider/server union | Map generated email provider config, secrets redacted; no invented mail transport. |
| allowLocalhost | optional boolean | Managed config via dedicated get/update API. |
| plugins | optional organization, magicLink, phoneNumber config | Use supported per-plugin APIs; preserve independent OAuth/trusted-domain collections. |
| webhook | optional enabled/url/events/timeout config | Observe/sync only managed fields; do not invent secret/signing fields absent from SDK. |

Outputs: scope, database/integration identity, managed Better Auth `baseUrl`, `jwksUrl`, observed nonsecret config and schema/table metadata if useful. Do not expose deprecated Stack Auth SDK key fields as Better Auth requirements. Secrets are redacted; browser receives only public Auth/JWKS endpoints, never account key/server credentials.

### Actual SDK mapping

| Aspect | Observe | Ensure/sync/delete |
| --- | --- | --- |
| Integration | `getNeonAuth({ project_id, branch_id })` | `createNeonAuth({ project_id, branch_id, auth_provider: "better_auth", database_name? })`; `disableNeonAuth({ project_id, branch_id, delete_data? })` for owned integration deletion. The generated provider literal is `better_auth`. Omit destructive `delete_data` by default; deleting the neon_auth schema requires explicit ownership/opt-in semantics. |
| Display name | observed integration/config where returned | `updateNeonAuthConfig({ project_id, branch_id, name })` |
| Email/password | `getNeonAuthEmailAndPasswordConfig` | `updateNeonAuthEmailAndPasswordConfig` |
| Email provider | `getNeonAuthEmailProvider` | `updateNeonAuthEmailProvider({ project_id, branch_id, body })` |
| Localhost | `getNeonAuthAllowLocalhost` | `updateNeonAuthAllowLocalhost` |
| Plugin aggregate | `getNeonAuthPluginConfigs` | `updateNeonAuthOrganizationPlugin`, `updateNeonAuthMagicLinkPlugin`; phone-specific `getNeonAuthPhoneNumberPlugin` / `updateNeonAuthPhoneNumberPlugin` |
| Webhook | `getNeonAuthWebhookConfig` | `updateNeonAuthWebhookConfig({ project_id, branch_id, enabled, webhook_url?, enabled_events?, timeout_seconds? })` |

Use observe → ensure → per-aspect sync → re-read URL/config. Own only explicitly managed singleton aspects and capture original values for an explicitly adopted shared singleton when restoration is the promised ownership model. Never blindly reset unknown settings or children. For removal, identify each API's documented disable/reset/default representation; if a reset is not expressible, fail explicitly rather than silently leave the old value. Control-plane fields not observable (e.g. secret values) need explicit write-only semantics, not cached-equality claims.

Foreign/inherited integration is Unowned until adoption. Child modifications must target child branch only; verify copied auth settings and user state independently. Disabling Auth can affect its managed data; deletion of an explicitly owned/adopted integration must follow the documented resource contract, never an incidental browser test or sibling child cleanup. Do not use `createBranchNeonAuthNewUser`, `deleteBranchNeonAuthUser` or user-role operations as production IaC resources.

## AuthOAuthProvider contract

Required `auth` reference and supported provider ID; optional clientId, redacted clientSecret, microsoftTenantId where generated API accepts it. Scope/provider ID is identity; changing auth scope or ID replaces. Mutable provider settings sync in place. Outputs: auth scope, provider ID/type and public config; client secret remains redacted if retained. Avoid exposing secrets through Object spread of SDK responses.

Actual SDK: `listBranchNeonAuthOauthProviders` → exact ID lookup; `addBranchNeonAuthOauthProvider({ project_id, branch_id, id, client_id?, client_secret?, microsoft_tenant_id? })`; `updateBranchNeonAuthOauthProvider({ project_id, branch_id, oauth_provider_id, ... })`; `deleteBranchNeonAuthOauthProvider({ project_id, branch_id, oauth_provider_id })`. Recover conflicts only after observation/ownership checks. Removal of optional client fields needs verified API semantics, not undefined-as-delete assumptions.

The Auth parent must never also reconcile the aggregate OAuth collection from `getNeonAuthPluginConfigs`; otherwise the resource and parent compete. Inherited same-ID config requires explicit child adoption. Removing one provider must preserve every unrelated provider and parent-branch configuration.

## AuthTrustedDomain contract

Required `auth` and trusted domain/origin. Scope + canonical origin is identity; changes replace. Normalize only the documented allowed form; do not broaden an exact origin into a wildcard or assume hostname-only custom-domain rules apply. Outputs: scope/origin and SDK verification/redirect metadata where present.

Actual SDK: `listBranchNeonAuthTrustedDomains`; `addBranchNeonAuthTrustedDomain({ project_id, branch_id, domain, auth_provider: "better_auth" })`; `deleteBranchNeonAuthTrustedDomain({ project_id, branch_id, auth_provider: "better_auth", domains: [...] })`. Delete array contains only this owned origin, not the whole observed collection. No update API; replacement adds/removes independent origin where identities differ. Parent Auth must not own the same list as a props collection.

Separate origin resources avoid Auth↔Website cycles: create Auth, create Function/Website using Auth URLs, then add returned origin as trusted domain. Auth shouldn't wait for Website URL as a mandatory singleton prop.

## Exact acceptance

1. Auth lifecycle creates real managed Better Auth, reads usable base/JWKS URLs, no-op does not rewrite settings, mutable flags/config and documented removal/reset converge against live state; database/scope changes replace safely.
2. Runtime/browser signup → signin → session/JWT → protected Function → signout works; unauthorized and expired tokens fail. Verify issuer/signature with established JWT libraries and JWKS refresh, not decode-only checks. End-user test accounts are fixture data confined to the owned Auth branch.
3. Email/password, localhost, plugin and webhook settings are independently exercised. Real email/phone/OAuth provider credentials or webhook delivery requirements are separate explicit gates. No blanket skip of core Auth lifecycle because an external OAuth client is unavailable.
4. OAuth add/update/no-op/delete preserves unrelated provider config; trusted-origin add/remove affects just one owned entry, including multiple concurrent origins and Website dependency order. Invalid provider/origin API errors remain typed.
5. Fork owned backend and verify inherited config/auth state, child-local updates and parent isolation; no automatic inherited adoption/deletion. Child cleanup never disables parent Auth.
6. Secrets absent from plan logs, runtime diagnostics, browser assets and generated docs; account key never bundled. Public Auth endpoint sharing is allowed and is not a server credential.
7. Delete child configs before owned Auth; `disableNeonAuth` repeated/absent behavior and URL/config absence verified via typed SDK. No tests or feature entitlement probes ran during this assessment.
