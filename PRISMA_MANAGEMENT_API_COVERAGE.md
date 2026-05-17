# Prisma Management API Coverage In Alchemy

Generated: 2026-05-16

This is a human-readable snapshot of the public Prisma Management API surface
covered by the Alchemy Prisma provider. The enforced source of truth is
`packages/alchemy/test/Prisma/ManagementCoverage.test.ts`, which parses the
cloned `pdp-control-plane` SDK types, mounted Management API route source, and
the cloned `project-compute` SDK route calls.

## Summary

- Public Management API routes covered: 68.
- Lifecycle resources: 8 direct resources plus `ComputeApp` as a higher-level
  Compute application resource.
- Operation-only helpers: 21 helper routes exposed through `alchemy/Prisma`.
- Admin routes: intentionally excluded. The test verifies `routes/admin.ts` is
  mounted under `/__admin`, protected by `adminAuthentication()`, and absent
  from the public SDK types.
- Prisma Compute SDK parity: the 14 route calls used by `project-compute` are
  covered by the same public route set.

## Lifecycle Resource Routes

### `Prisma.Project`

- `GET /v1/projects`
- `POST /v1/projects`
- `GET /v1/projects/{id}`
- `PATCH /v1/projects/{id}`
- `DELETE /v1/projects/{id}`

### `Prisma.Database`

Also exported as the product-shaped `Prisma.Postgres` convenience alias.

- `GET /v1/databases`
- `POST /v1/databases`
- `GET /v1/projects/{projectId}/databases`
- `POST /v1/projects/{projectId}/databases`
- `GET /v1/databases/{databaseId}`
- `PATCH /v1/databases/{databaseId}`
- `DELETE /v1/databases/{databaseId}`

### `Prisma.Connection`

- `GET /v1/connections`
- `POST /v1/connections`
- `GET /v1/databases/{databaseId}/connections`
- `POST /v1/databases/{databaseId}/connections`
- `GET /v1/connections/{id}`
- `DELETE /v1/connections/{id}`

### `Prisma.Branch`

- `GET /v1/projects/{projectId}/branches`
- `POST /v1/projects/{projectId}/branches`
- `GET /v1/branches/{branchId}`
- `PATCH /v1/branches/{branchId}`
- `DELETE /v1/branches/{branchId}`

### `Prisma.ComputeService`

- `GET /v1/compute-services`
- `POST /v1/compute-services`
- `GET /v1/projects/{projectId}/compute-services`
- `POST /v1/projects/{projectId}/compute-services`
- `GET /v1/compute-services/{computeServiceId}`
- `PATCH /v1/compute-services/{computeServiceId}`
- `DELETE /v1/compute-services/{computeServiceId}`

### `Prisma.ComputeVersion`

- `GET /v1/versions`
- `POST /v1/versions`
- `GET /v1/versions/{versionId}`
- `DELETE /v1/versions/{versionId}`
- `GET /v1/compute-services/{computeServiceId}/versions`
- `POST /v1/compute-services/{computeServiceId}/versions`
- `GET /v1/compute-services/versions/{versionId}`
- `DELETE /v1/compute-services/versions/{versionId}`

### `Prisma.EnvironmentVariable`

- `GET /v1/environment-variables`
- `POST /v1/environment-variables`
- `GET /v1/environment-variables/{envVarId}`
- `PATCH /v1/environment-variables/{envVarId}`
- `DELETE /v1/environment-variables/{envVarId}`

### `Prisma.SourceRepository`

- `GET /v1/source-repositories`
- `POST /v1/source-repositories`
- `GET /v1/source-repositories/{id}`
- `DELETE /v1/source-repositories/{id}`

## Higher-Level Resource

### `Prisma.ComputeApp`

`ComputeApp` composes the public Compute routes above into a Worker-like app
experience:

- creates or updates a project-owned Compute service
- reconciles environment variables through `/v1/environment-variables`
- builds or accepts an artifact
- creates a service-scoped Compute version
- uploads, starts, promotes, tails logs, and destroys owned Compute state
- runs a local dev command without Prisma credentials in dev mode

Alchemy also exports `destroyComputeProject`, `destroyComputeService`, and
`destroyComputeVersion` as lower-level cleanup helpers for live smoke recovery
or other operational scripts.

## Operation-Only Helpers

These routes are exposed as direct helper functions from `alchemy/Prisma`
because they are actions, lists, or reads rather than stable stack-owned
resources.

- `POST /v1/projects/{id}/transfer`
- `GET /v1/databases/{databaseId}/backups`
- `POST /v1/databases/{targetDatabaseId}/restore`
- `GET /v1/databases/{databaseId}/usage`
- `POST /v1/connections/{id}/rotate`
- `POST /v1/compute-services/{computeServiceId}/promote`
- `POST /v1/versions/{versionId}/start`
- `POST /v1/versions/{versionId}/stop`
- `POST /v1/compute-services/versions/{versionId}/start`
- `POST /v1/compute-services/versions/{versionId}/stop`
- `GET /v1/compute-services/versions/{versionId}/logs`
- `GET /v1/workspaces`
- `GET /v1/workspaces/{id}`
- `GET /v1/regions`
- `GET /v1/regions/postgres`
- `GET /v1/regions/accelerate`
- `GET /v1/integrations`
- `GET /v1/integrations/{id}`
- `DELETE /v1/integrations/{id}`
- `GET /v1/workspaces/{workspaceId}/integrations`
- `DELETE /v1/workspaces/{workspaceId}/integrations/{clientId}`

## Prisma Compute SDK Route Parity

The coverage test also parses `project-compute/sdk/src/api-client.ts` and pins
the route calls that matter for SDK-style deploy/destroy. All 14 are covered by
the public Alchemy route set:

- `DELETE /v1/compute-services/{computeServiceId}`
- `DELETE /v1/compute-services/versions/{versionId}`
- `GET /v1/compute-services/{computeServiceId}`
- `GET /v1/compute-services/{computeServiceId}/versions`
- `GET /v1/compute-services/versions/{versionId}`
- `GET /v1/projects`
- `GET /v1/projects/{id}`
- `GET /v1/projects/{projectId}/compute-services`
- `POST /v1/compute-services/{computeServiceId}/promote`
- `POST /v1/compute-services/{computeServiceId}/versions`
- `POST /v1/compute-services/versions/{versionId}/start`
- `POST /v1/compute-services/versions/{versionId}/stop`
- `POST /v1/projects`
- `POST /v1/projects/{projectId}/compute-services`

## Current Blocker

The only known unmet end-to-end gate is live destroy. The live deploy/fetch path
worked, but Prisma Compute returned HTTP 500 deleting a stopped Compute version,
which leaves the service and project blocked by 409 responses. Details and
repro commands are in `PRISMA_COMPUTE_PLATFORM_BUGS.md`.
