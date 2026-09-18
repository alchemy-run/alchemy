# Project and Branch corrections

Status: `Neon.Project` **partial**, `Neon.Branch` **partial**. Existing source, registration and Project/Branch test files are present; no tests ran during this assessment. Required scope is compatibility and backend readiness, not database administration expansion. Apply acceptance G0–G4 and G10.

## Files

`packages/alchemy/src/Neon/{Project,Branch,Migrations,PostgresOrigin,Providers,index}.ts`; `packages/alchemy/test/Neon/{Project,Branch,Providers}.test.ts`; shared migrations under `packages/alchemy/src/SQL/Migrations/`. SDK operation source is `submodules/distilled/packages/neon/src/services/neon.ts`.

## Project contract and immutable rules

| Input | Type/default | Reconciliation rule |
| --- | --- | --- |
| name | optional string; deterministic generated name | Preserve current explicit-name replacement behavior for compatibility; do not confuse SDK mutable display-name capability with approval to change existing Alchemy identity semantics. |
| region | NeonRegion; existing default `aws-us-east-1` | Replaces; new combined-backend examples explicitly use Ohio, not a changed Project default. |
| pgVersion | supported Postgres version; 17 | Replaces. |
| orgId | optional string | Creation identity; replace on change. No organization transfer API added. |
| defaultBranchName / roleName / databaseName | optional strings; provider defaults | Creation inputs; explicit changes replace rather than silently ignoring. Preserve omitted values on adoption/refresh. |
| historyRetentionSeconds | number; 86400 | Sync observed mutable value. Test explicit removal/default semantics. |
| enableLogicalReplication | boolean; false | Can enable, cannot disable in place. Attempt to remove/disable a previously enabled value must be an explicit typed unsupported transition or approved replacement, never silently claim false or send a known-invalid update. |
| migrations / importFiles | existing MigrationsInput / string[] | Preserve SQL migration bookkeeping/import content hashes; no automatic rollback of application data on property removal. |

Stable attributes: projectId and defaultBranchId for ordinary updates. Preserve projectName, region, pgVersion, defaultBranchName, databaseName, roleName, connectionUri, pooledConnectionUri, origin, pooledOrigin, retention/replication fields and migration/import hashes. Existing connection strings are legacy string outputs; do not introduce a breaking change while adding redacted Connect effects. Never include their values in logs/public examples/census.

### Project SDK mapping

- Observe/recover: `getProject({ project_id })`; when cached identity is absent, bounded `listProjects({ search, cursor })`, exact-name filtering and explicit ownership/ambiguity checks. Do not adopt the first match.
- Ensure: `createProject({ project: { name, region_id, pg_version, org_id, branch: { name, role_name, database_name }, history_retention_seconds, settings: { enable_logical_replication } } })`.
- Sync: `updateProject({ project_id, project: ... })` against `getProject` state, not cached output. Observe before ensure even when output exists.
- Refresh default branch/database: `listProjectBranches`, selecting `default === true`; `listProjectBranchDatabases`; `getConnectionURI` twice with `pooled: false/true`. Do not assume name `main` or choose an arbitrary first row as default. Honor explicit database/role selections.
- Await operations: `getProjectOperation({ project_id, operation_id })`; typed bounded waiter must fail pending-exhaustion and terminal failures, including cancelled work where desired state was not achieved. Poll budget ≤10 attempts, total backoff <60s.
- Delete: `deleteProject({ project_id })`, typed not-found tolerance, fresh not-found verification. Project owns its implicit default branch/database/role; delete only an owned/adopted project after managed dependents are removed.

## Branch contract and immutable rules

| Input | Type/default | Reconciliation rule |
| --- | --- | --- |
| project | Project or `{ projectId }`; required | Resolved project identity replaces; unresolved upstream changes must still plan safely. |
| name | optional string; generated | Mutable rename; preserve cached generated physical name when prop omitted. |
| parentBranch | Branch, `{ branchId }`, or `{ name }`; project default | Fork source; changing resolved parent replaces. Do not rename/reparent an existing branch implicitly. |
| parentLsn / parentTimestamp | optional string | Point-in-time fork identity; mutually exclusive; change/removal must not be silently ignored. Replace when fork identity changes. |
| initSource | `parent-data` default or `schema-only` | Replaces. |
| protected | boolean; false | Mutable, with explicit API constraints; cleanup must not mutate a borrowed parent or silently bypass protection. |
| expiresAt | optional RFC3339 string | Mutable; remove with supported null reset. |
| endpoints | BranchEndpointConfig[]; one read_write | Branch owns these endpoints. Create/read/sync/delete endpoint deltas by observed identity. CU min/max and suspend timeout update; endpoint type change requires endpoint replacement, not whole-branch data replacement. |
| migrations / importFiles | existing types | Same bookkeeping guarantees as Project, scoped to child database. |

Attributes retain branchId, branchName, projectId, parentBranchId, parentLsn, parentTimestamp, initSource, protected/default/expiry, databaseName/roleName, direct/pooled connection URIs/origins and migration/import hashes. branchId/projectId stay stable for rename/settings updates. Refresh connections after endpoint changes rather than retaining stale cached URIs.

### Branch and endpoint SDK mapping

- Observe: `getProjectBranch`; recovery/default lookup through bounded `listProjectBranches` with `pagination.next`, exact names and ambiguity rejection. Resolve parent within the same project.
- Ensure: `createProjectBranch({ project_id, branch: { name, parent_id, parent_lsn, parent_timestamp, init_source, protected, expires_at }, endpoints })`; wait returned operations.
- Sync branch scalar fields: `updateProjectBranch`, wait its operations, re-read final attributes.
- Observe endpoints: `listProjectBranchEndpoints({ project_id, branch_id })` or `getProjectEndpoint({ project_id, endpoint_id })`.
- Ensure endpoint: `createProjectEndpoint({ project_id, endpoint: { branch_id, type, autoscaling_limit_min_cu, autoscaling_limit_max_cu, suspend_timeout_seconds } })`.
- Sync CU/suspend settings: `updateProjectEndpoint({ project_id, endpoint_id, endpoint: ... })` using observed values. Only manage endpoints owned by Branch. Preserve unknown/adopted endpoints unless ownership explicitly covers them.
- Remove owned endpoint: `deleteProjectEndpoint`; wait operation completion and refresh URI. Preserve a supported read-write path when required for migrations/runtime.
- Delete branch: `deleteProjectBranch`; typed absence and bounded verification. Never delete the project's default/root branch as if it were an ordinary owned child.

## Concrete initial defects to finish

Project reconcile currently branches on cached output (`Project.ts` around 306), refresh carries cached connections, immutable diffs omit some creation fields, name lookup takes the first match, and deletion logs whole errors. `waitForOperations` uses an unknown-typed tag predicate, an inappropriate schedule combination with 60 recurrences, and swallows pending exhaustion. Branch reconcile similarly branches on output (`Branch.ts` around 339), retains cached connections, passes endpoints only on create, and does not robustly model parent/endpoint changes. Fix provider behavior rather than masking it in tests. Source line numbers are assessment anchors and may move during concurrent implementation.

## Exact acceptance additions

1. Existing migration/connection/origin consumers continue working unchanged; default region remains `aws-us-east-1`.
2. Rename/settings no-op yields no unnecessary update; mutate live retention/protection/endpoint CU and reconcile back to desired state.
3. Delete cloud Project/Branch out of band only inside own test fixtures, then reconcile with cached output and verify recreation plus fresh connection outputs.
4. Endpoint settings and removals converge through endpoint APIs without replacing the branch; real SQL succeeds after update. Assert parent remains unchanged after child SQL/migration writes.
5. All creation-identity props, including explicit removal semantics, have diff/replacement coverage; preserve old/new project dependencies throughout replacement tests.
6. Pending exhaustion and failure/cancelled operation cannot be reported as success. Typed SDK errors replace unknown structural predicates.
7. Foreign/duplicate names require explicit adoption and cannot make deletion target an unrelated project/branch. Census avoids the providers' broad connection-hydrating list methods.

Conditional Endpoint resource: only introduce `Neon.Endpoint` if independent ownership is genuinely required, transfer endpoint ownership explicitly, and add a separate catalog item at that time. Never introduce `Compute` as a Function/endpoint alias.
