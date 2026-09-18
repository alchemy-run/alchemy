# DataApi and AIGateway

Initial status: **missing** for Neon.DataApi resource and Neon.AIGateway construct. They are not interchangeable: DataApi has lifecycle operations, AIGateway only endpoint discovery plus optional managed credentials. Gates G0–G5, G9–G10.

## Files

`packages/alchemy/src/Neon/{DataApi,AIGateway}.ts`, minimal resource/barrel registration as appropriate; tests `packages/alchemy/test/Neon/{DataApi,AIGateway}.test.ts`; ConnectDataApi/ConnectAIGateway bindings in `bindings.md`. Do not register an invented AIGateway CRUD provider.

## DataApi contract

Scope: exclusive branch/project selection, database name required or deliberately derived from the referenced branch's selected database. Identity is project + branch + database; changes replace. Inputs also expose only supported configuration: auth provider `neon_auth` or `external`, JWKS URL for external, provider display name, optional JWT audience, explicit add-default-grants and skip-auth-schema flags, and supported PostgREST settings. Default to no surprising broad grants; passing a database reference does not confer ownership of its schema/data.

Supported settings map to generated `DataAPISettings`: aggregates, anonymous role, extra search path, max rows, exposed schemas (documented default public), role-claim key, JWT cache lifetime, OpenAPI mode, CORS origins and server-timing. Keep plain typed Props; do not claim arbitrary PostgREST/server configuration is supported. Outputs include scoped database identity, URL, deployment status and observed settings; available schemas can be null. No admin token is a runtime output.

### Actual SDK mapping and update limits

| Phase | SDK / wire |
| --- | --- |
| Observe | `getProjectBranchDataAPI({ project_id, branch_id, database_name })`: GET `/projects/{project_id}/branches/{branch_id}/data-api/{database_name}`; returns url/status/settings/available_schemas. |
| Ensure | `createProjectBranchDataAPI({ project_id, branch_id, database_name, auth_provider?, jwks_url?, provider_name?, jwt_audience?, add_default_grants?, skip_auth_schema?, settings? })`: POST same path. |
| Sync settings | `updateProjectBranchDataAPI({ project_id, branch_id, database_name, settings? })`: PATCH same path. Its assessed update contract supports settings only, not auth_provider/JWKS/audience. |
| Delete | `deleteProjectBranchDataAPI({ project_id, branch_id, database_name })`: DELETE same path; typed absent tolerance, then get absence. |

Observe → ensure → settings delta → re-read status/URL. Creation auth fields and grant/schema initialization are not read-back in the assessed response. Before advertising mutable authentication settings, verify whether repeated create is a supported convergent configuration operation or a documented JWKS contract covers it. Existing `getProjectJWKS` / `addProjectJWKS` / `deleteProjectJWKS` are project-wide; do not mutate shared project authentication as a hidden branch-resource side effect. Until supported semantics are proven, treat auth configuration as creation-only with explicit replacement/reconfiguration handling, and preserve unrelated grants. Never silently send unsupported PATCH fields or claim unreadable settings drift is observable.

Identity replacement at the same database path conflicts and must be delete-first for the owned API configuration, not database recreation. Deleting DataApi must not delete database/user data. An adopted/inherited API needs explicit management boundaries; removing managed settings resets only through documented API semantics, otherwise report an unsupported reset. Do not let child teardown touch a parent's API or project JWKS.

### DataApi exact acceptance

Create with Neon Auth, create with external JWKS in separately authorized fixtures; observed settings no-op/update/removal; scoped database replacement; drift/deletion recovery; explicit adoption and second delete. Real PostgREST SELECT/write with valid end-user token and RLS constraints; absent/expired/wrong issuer/signature/audience token rejection as actually supported. SDK notes audience configured mismatches are rejected but tokens with no audience can still be accepted: do not overstate stricter validation. Bound client forwards caller authorization and never substitutes a deploy/admin key. Parent/child database/API isolation verified. Auth configuration update/reset gaps and grant side effects must have real regression evidence before marking complete.

## AIGateway contract

A construct resolving branch endpoint configuration, optionally taking an explicitly managed Credential override. Shared scope rules apply. Outputs: projectId/branchId, endpoint root and enabled state; redacted token only through an appropriate connection binding/explicit credential, never account-key reuse. No mutable chat/model methods on the infrastructure object. Changing scope reconnects dependencies and replaces a managed credential where needed; there is no gateway create/update/delete lifecycle to synthesize.

Actual discovery SDK: `getProjectBranchAiGateway({ project_id, branch_id })` → GET `/projects/{project_id}/branches/{branch_id}/ai_gateway`, returns enabled/base_url. A successful response's enabled is documented true, not an enable operation. Credential lifecycle uses `createCredential`/`listCredentials`/`revealCredential`/`revokeCredential` with `ai_gateway:invoke`, only if platform injection cannot satisfy the runtime connection. Destroy removes only an explicitly owned managed credential, not the branch's gateway service.

Same-branch Neon Function uses injected `NEON_AI_GATEWAY_TOKEN` and `NEON_AI_GATEWAY_BASE_URL`; external Worker/Lambda/local hosts get a target-branch scoped credential and namespaced secret. Credentials obey branch lineage, not a model-level or Function-level policy. Scope override must validate requested grant/lineage. Platform-injected broad credentials remain present in a Function even if the client uses a restricted credential.

SDK compatibility: expose configuration for `@neon/ai-sdk-provider` and compatible model SDKs, with native streaming and Effect-wrapped examples. Model is configurable, never purchase credits to make a fixture pass. Runtime injected base URL is documented host root; Chat Completions appends `/v1`, Responses appends `/openai/v1`. Control-plane description uses an endpoint-root wording that must be checked against actual URL values: normalize only from verified contract and test against double-prefix or duplicated `/ai-gateway` paths. Do not concatenate an assumed dialect twice.

### AIGateway exact acceptance

Discovery and endpoint routing, same-branch native injected configuration, explicit external credential creation/reveal/revocation, native SDK streaming, Effect-wrapped model call, client cancellation and sanitized errors. Test both Chat/Responses dialect construction against observed base URL and SDK-compatible client routing. Cross-host Worker/Lambda connection configuration must be real where supported; only model inference is gated on actual credit/entitlement rejection. Record exact typed API/runtime error and mark inference unverified when blocked. No automatic plan upgrade/credit purchase; no fake gateway CRUD. Parent/child credential isolation and no account key in runtime/browser/logs required.

Service availability: unknown. Final preflight resolves the environment credential, getAuthDetails succeeds and listProjects returns zero visible projects; getCurrentUserInfo/getActiveRegions return typed NotFound. Root dependencies now resolve. No AI invocation/charge or DataApi mutation was attempted; see preflight.md.
