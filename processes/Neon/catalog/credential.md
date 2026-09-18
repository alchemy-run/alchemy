# Neon.Credential

Initial status: **missing**. Kind: branch-scoped resource. `Neon.Credentials` already exists but is a plural deployment-auth service, not this resource. Mandatory gates: G0–G4, G5 external-host security, G10.

## Files and contract

Implement `packages/alchemy/src/Neon/Credential.ts`, register minimally in Neon Providers/index, and add a real `packages/alchemy/test/Neon/Credential.test.ts`. SDK names below already exist in the assessed generated service.

| Input | Type/default | Identity/update behavior |
| --- | --- | --- |
| branch or project | exclusive shared scope contract | Resolved project/branch change replaces. |
| name | optional deterministic stable label | No rename endpoint exists; explicit label change replaces. A label is not ownership proof. |
| scopes | nonempty supported scope array | Normalize/deduplicate; scope changes replace, never mutate/rotate the same identity implicitly. |

Customer principal is fixed to `principal_type: "user"`. Supported requested scopes are `storage:read`, `storage:write`, `ai_gateway:invoke`, `functions:invoke`. Do not issue platform-internal `function` or `system` principals. Response scopes can include additional opaque values, including `telemetry:write`; do not reject an existing credential merely because the response scope is outside the issuance enum.

Outputs: projectId, branchId, tokenId, optional short ID, name, observed scopes, createdAt/expiresAt, redacted apiToken and redacted s3SecretAccessKey. Stable tokenId survives no-op/recovery; it changes only on replacement or explicit rotation action. S3 access-key ID is token_id, not api_token. No account API key is ever returned/bound.

## Actual SDK lifecycle mapping

| Phase | Operation / HTTP |
| --- | --- |
| Observe metadata | `listCredentials({ project_id, branch_id })`: GET branch `/credentials`; match stored token_id first, then unique deterministic label with ownership checks. |
| Ensure missing | `createCredential({ project_id, branch_id, name, scopes, principal_type: "user" })`: POST branch `/credentials`. Persist returned token identity/secrets securely. |
| Recover secrets | `revealCredential({ project_id, branch_id, token_id })`: POST branch `/credentials/{token_id}/reveal` after observing metadata. Verify actual response/redaction in SDK live/wire tests. No rotation as recovery. |
| Sync | No credential update API. Compare observed lineage/scopes; unchanged secret stays unchanged. Replacement owns both identities until dependents switch. |
| Delete | `revokeCredential({ project_id, branch_id, token_id })`; tolerate only typed absence and confirm metadata no longer lists token. |
| Explicit action only | `rotateCredential({ project_id, branch_id, token_id })`; caller-requested action, not an automatically retried reconcile step or lost-response recovery technique. |

A lost create response may leave an unmatched label. Re-list, require a unique owned candidate and reveal; multiple matches fail safely. Mere name equality without provenance is Unowned/adoption, not license to reveal/use/revoke arbitrary customer credentials. Revealing secrets during this catalog preflight is not authorized and was not performed.

## Security/inheritance

Storage credentials are branch-lineage scoped: ancestors can reach descendants; child credentials must not reach parents or unrelated branches. `storage:write` grants reads too. Neither a bucket-bound nor object-bound client creates per-bucket/per-key IAM. `functions:invoke` being issuable does not prove public Functions require it. External hosts mint at the narrow target branch, never a broader ancestor for convenience.

The SDK currently marks api_token sensitive but represents s3_secret_access_key as an ordinary string in create/reveal/rotate shapes. Route that redaction gap to the sole SDK owner. Redact all secrets in Alchemy regardless of displayed environment metadata; never log raw SDK error/request/credential objects.

## Exact acceptance

- Create/read/no-op preserves token identity and secret; scope/label/scope-parent replacement revokes old token only after consumers switch.
- Reveal recovers identical credentials from metadata after simulated state-secret loss; ambiguous label recovery fails without rotating or revoking anything.
- External Worker and Lambda storage clients prove read allows reads/list but denies writes, write can read/write, child/ancestor/wrong-lineage behavior matches documented limits, and managed token is revoked after stack cleanup.
- Matching host/branch/scope consumers share one managed credential; different branch/scope consumers do not overwrite each other's namespaced secrets or ambient AWS credentials.
- Injected same-branch Neon Function path provisions no unnecessary customer credential. Its read-only typed client is not represented as a process-wide sandbox.
- Create/reveal/rotate protocol regressions enforce redaction of both secret forms. Explicit rotate behavior is separately verified, never used to make lifecycle recovery pass.
- Live cleanup verifies metadata absence and failure of revoked credential against an owned test object, with bounded typed retries. No credential lifecycle test was run in this assessment. Final preflight credentials/auth/project-list probes pass, but region lookup returns typed NotFound and no owned project was selected; see preflight.md.
