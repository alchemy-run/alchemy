# Neon backend implementation catalog

This is implementation support for the approved Neon backend plan, assessed on 2026-09-17. Read [acceptance.md](acceptance.md) first; it defines exact G0–G10 completion gates and source anchors. [preflight.md](preflight.md) contains actual read-only evidence and the scoped baseline procedure. [summary.json](summary.json) is the machine-readable inventory.

**Current integration inventory: all 38 required source contracts are present; complete acceptance remains outstanding.** The coordinator has verified SDK regressions and typechecks, frontend regressions, and collected scoped live and browser results. See [verification](../verification.md) for the current evidence and blockers. The machine-readable inventory separates source presence from acceptance.

The tables and preflight below preserve the initial assessment (2 partial,36 missing) as historical design context. They are not the current implementation status. No complete scoped, leak-free acceptance round has yet passed.

## Actual preflight verdict

- Node 24.10.0, pnpm 11.25.0, Bun 1.3.13 and timeout are available. Initial dependencies were unresolved; final read-only recheck confirms Alchemy imports Neon SDK and root/Alchemy/Neon/core share Effect 4.0.0-rc.115's realpath. This agent installed nothing.
- NEON_API_KEY is present and resolves through existing Neon credential/auth/store layers. `ALCHEMY_PROFILE=testing` was selected, but environment credentials take precedence; stored testing-profile configuration remains unverified.
- Four bounded read-only SDK requests, zero automatic retries: getAuthDetails **succeeded**; getCurrentUserInfo **NotFound**; getActiveRegions **NotFound**; listProjects **succeeded**, with **0 visible projects / 0 proposed-namespace matches**, one complete page. No account identity, secret or user data logged.
- Zero cloud mutations. Region/service eligibility, authorized creation, concrete owned branch namespace, DNS authority/HTTPS and AI entitlement remain unverified. Zero visible projects is not an account-wide leak/organization census.
- Prisma #1683 is **MERGED**, head `1503d1777d22a2a0e4dccbc3d59ae11c507412fa`, merge `530a201e497a0ddba9e7be12ed0f0180cc8b668c`, merged at `2026-09-17T21:39:07Z`. Its revision was read without merging main.
- Root `.gitignore` ignores `/processes/`; catalog files exist on disk but ordinary git status omits them. Coordinator must explicitly include them if tracking is desired. Ignore rules/staging were not changed.

## Resource and construct inventory

All live testability verdicts are **limited/unverified** until the corresponding scoped real gates pass. SDK column describes the initial assessed SDK, not an assertion that the SDK owner's concurrent regeneration is incomplete.

| Required surface | Kind | Initial status | Spec | SDK/critical acceptance |
| --- | --- | --- | --- | --- |
| Neon.Project | resource | partial | [postgres](postgres.md) | Existing project CRUD, default branch/URI refresh, immutable props and bounded typed waiter corrections |
| Neon.Branch | resource | partial | [postgres](postgres.md) | Existing branch + endpoint CRUD; observed endpoint updates and parent isolation |
| Neon.Bucket | resource | missing | [storage](storage.md) | Bucket management + S3 CORS/tags; public API still lacks visibility PATCH; preserve populated data |
| Neon.Object<T> | resource | missing | [storage](storage.md) | S3 bytes/metadata plus typed JSON/value/body/source, ownership, schema/decode/type propagation |
| Neon.Credential | resource | missing | [credential](credential.md) | list/create/reveal/revoke/explicit rotate; S3 secret redaction, branch scopes, no rotation on recovery |
| Neon.Function | resource/platform | missing | [function](function.md) | Deployment ZIP, requested active ID, write-only env, native/Effect bridge, local RPC, WebSocket/waitUntil |
| Neon.FunctionTrigger | resource | missing | [triggers/domains](triggers-domains.md) | Five public CRUD IDs absent initially; discriminator, mutable same-branch target, immutable type, inherited-disabled |
| Neon.CustomDomain | resource | missing | [triggers/domains](triggers-domains.md) | list/register/delete; conflict-aware replacement, CNAME output before DNS, separate real TLS gate |
| Neon.Auth | resource | missing | [auth](auth.md) | Managed Better Auth integration/config; never confuse deployment AuthProvider; preserve data by default |
| Neon.AuthOAuthProvider | resource | missing | [auth](auth.md) | Independent provider list/add/update/delete, redacted secret, no competing parent collection |
| Neon.AuthTrustedDomain | resource | missing | [auth](auth.md) | Independent origin list/add/delete, preserve other origins and avoid Website cycle |
| Neon.DataApi | resource | missing | [DataApi/AI](data-api-ai.md) | Existing GET/POST/PATCH/DELETE; PATCH settings only, auth/JWKS changes need verified handling |
| Neon.AIGateway | construct | missing | [DataApi/AI](data-api-ai.md) | getProjectBranchAiGateway discovery only; credentials when needed, no invented CRUD |

## Runtime bindings and event sources

Each binding/layer pair is separately accepted, not a single contract counted twice. All are initially **missing**; detailed inputs, outputs, env/scopes, operations and negative controls are in [bindings.md](bindings.md).

| Contract | Required implementations | Critical evidence |
| --- | --- | --- |
| Connect | ConnectBinding | Injected/explicit redacted pooled/direct connection; real SQL on Function/Worker/Lambda |
| ReadBucket | ReadBucketBinding / ReadBucketHttp | Injected versus managed storage:read; external write denied; list/head/get/presign |
| WriteBucket | WriteBucketBinding / WriteBucketHttp | storage:write includes reads; multipart/batch/presigned upload/CORS |
| ReadWriteBucket | ReadWriteBucketBinding / ReadWriteBucketHttp | One composed client/credential, no duplicate grants |
| ReadObject<T> | ReadObjectBinding / ReadObjectHttp | get T or undefined; schema/decode error; reuse bucket scope |
| WriteObject<T> | WriteObjectBinding / WriteObjectHttp | Compile-safe value writes/raw fidelity; no per-key policy fiction |
| InvokeFunction | InvokeFunctionBinding | Public HTTP streaming/cancellation; caller auth explicit, no admin token |
| ConnectAuth | ConnectAuthBinding | Public base/JWKS URLs; real verified JWT/auth flow |
| ConnectDataApi | ConnectDataApiBinding | Forward per-request end-user token; RLS/tenant isolation |
| ConnectAIGateway | ConnectAIGatewayBinding / ConnectAIGatewayHttp | Native/model SDK configuration, correct dialect route, scoped token/credit gating |
| CronEventSource | CronEventSourceBinding | [Trigger spec](triggers-domains.md); HTTP dispatch + same FunctionTrigger lifecycle; real bounded cron delivery separate |
| BucketEventSource | BucketEventSourceBinding | [Trigger spec](triggers-domains.md); real upload delivery, prefix filter, spoof rejection and idempotency |

## Thirteen Website acceptance items

Each has its own detailed spec, runnable example and guide requirement. All are initially **missing**, live/local/browser testability **limited/unverified**. [websites.md](websites.md) defines shared ownership, props/outputs, actual SDK lifecycle, packaging, local mode and full build/dev/deploy/update/no-op/destroy/browser matrix. G7 static + Fetch SSR + Next.js feasibility must pass before the wrapper family is called supported.

| Constructor | Detailed spec | Production boundary / distinguishing acceptance |
| --- | --- | --- |
| Neon.Website.Vite | [Vite](website-Vite.md) | Static Function assets, SPA/base path, VITE env, tutorial UI |
| Neon.Website.Astro | [Astro](website-Astro.md) | Fetch SSR + static modes, islands/forms/prerender/integrations |
| Neon.Website.Nextjs | [Nextjs](website-Nextjs.md) | Blocking Node-to-Fetch feasibility; pages/routes/actions/stream/assets/images/custom host |
| Neon.Website.Nuxt | [Nuxt](website-Nuxt.md) | Nitro listener/Fetch adapter, SSR/API/runtimeConfig |
| Neon.Website.SvelteKit | [SvelteKit](website-SvelteKit.md) | Fetch handler/server graph, enhanced forms and origin checks |
| Neon.Website.ReactRouter | [ReactRouter](website-ReactRouter.md) | Loaders/actions/error boundaries and deferred streams |
| Neon.Website.SolidStart | [SolidStart](website-SolidStart.md) | Nitro boundary, server functions/actions and hydration |
| Neon.Website.TanStackStart | [TanStackStart](website-TanStackStart.md) | Fetch entry, server functions and client routing |
| Neon.Website.Waku | [Waku](website-Waku.md) | RSC/dynamic/prerender graph and streamed navigation |
| Neon.Website.Octane | [Octane](website-Octane.md) | Fetch handler with auto-listen suppressed, real SSR/interaction |
| Neon.Website.Foldkit | [Foldkit](website-Foldkit.md) | Own Foldkit fixture over Vite builder, SPA routing/HMR |
| Neon.Website.Vocs | [Vocs](website-Vocs.md) | Docs/Waku graph, sidebar/search/MDX/deep links |
| Neon.Website.StaticSite | [StaticSite](website-StaticSite.md) | Arbitrary build/output/native dev, custom 404/SPA, safe static Fetch package |

## Initial SDK and provider work queue

1. SDK owner refreshes the existing mirror and owns convert → generate → format. Public OpenAPI had 179 operations versus 158 initial SDK exports; five trigger CRUD IDs and binary deployment/download semantics are confirmed gaps. Never hand-edit generated code or let resource owners regenerate.
2. Bucket access mutation lacks a public PATCH even in the current spec; locate documented supported contract with evidence or return explicit unsupported-update preserving data. Do not recreate a populated bucket to simulate a mutable access field.
3. Correct observed Project/Branch/endpoint state and typed bounded operation waiter before relying on backend readiness. Current code assessment is in postgres.md; no silent migration/default-region incompatibility.
4. Validate secrets/reveal, ambiguous recovery/ownership, inherited branch behavior, env deletion/current-versus-active deployment and native runtime protocols. No catch-all status handling, automatic rotation or fabricated upload idempotency.
5. Every Website must pass real runtime/browser gates; Next runtime compatibility, AI credits and DNS/TLS are distinct outstanding items. No skipped feature becomes implemented because surrounding lifecycle passes.

## Recommended isolated starting scope

Use a deterministic coordinated stage (for example `neon_compute_backend`) and own project prefix `alchemy-neon-compute-backend-<owner>`, with engine instance suffixes and separate stack names. Confirm credential/account authorization before creation, recheck the visible-project baseline because peers may have created resources, then create one explicitly owned parent with per-owner child branches. Separate Project-replacement projects. Name matches are not ownership proof. Capture only own/inherited aggregate counts; no application data or token logs. Destroy through stack lifecycle, never broad nuke/hidden cleanup, and require two complete clean scoped rounds.

Conditional follow-up only: standalone `Neon.Endpoint` if Branch cannot own its endpoint changes, with explicit ownership transfer. Do not expand into billing/org administration, historical database resources, user/session IaC, fake storage IAM/notifications/website features, gateway CRUD or undocumented retry guarantees.
