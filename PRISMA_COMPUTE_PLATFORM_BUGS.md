# Prisma Compute Platform Bugs Found During Alchemy Smoke Testing

Generated: 2026-05-15T20:34:02Z
Last updated: 2026-05-17

Context: testing the new Alchemy Prisma `ComputeApp` resource against the live
Prisma Management API with a service token. The smoke flows created Prisma
projects, databases, compute services, compute versions, uploaded artifacts,
started/promoted versions, and exercised public URLs and cleanup.

No credentials are included in this file.

## Summary For Prisma Compute Team

- Basic Bun deploy path worked once: Alchemy created a project, service,
  version, uploaded the artifact, started/promoted it, and reached the deployed
  URL.
- An initial full Next.js deploy created and promoted a running version, but
  both the preview URL and stable service URL returned Prisma's edge 404 page:
  `There is no service on this URL.` After pulling Compute logs through
  `project-compute`, this specific incident was traced to an Alchemy archive
  bug: the app boot-looped because Bun package aliases were lost during archive
  creation. Fixed in this worktree.
- A fresh Next.js deploy after the Alchemy archive fix succeeded and served both
  `/` and `/api/health` from Prisma Compute.
- Destroy path is blocked upstream: the deployed version is already `stopped`,
  but both public delete routes return HTTP 500.
- Because that version remains non-deleted in control-plane state, service and
  project deletion both return 409.
- I did not find a public cleanup/force-delete workaround in the cloned
  `pdp-control-plane` or `project-compute` surfaces. The Compute SDK/CLI also
  relies on the same stop-then-delete version flow.
- The most actionable fix is likely around stopped-version deletion /
  `deleteVersionWithRecovery`, then confirming service deletion docs match the
  intended requirement: "stopped or deleted" versus "deleted only".
- I also found one source-contract drift between `project-compute` and the
  current Management API SDK around `envVars` in version-create payloads.

## 1. Boot-Looping Version Reported Running And Returned "Service Not Found"

Severity: high

Impact: the Management API can report a Compute version as `running` and
successfully promoted while the app is actually boot-looping. A deploy client
that only checks Management API state will report success even though the
user-facing app is unreachable.

Reclassification after checking `project-compute` logs: the broken artifact in
this specific Next.js deploy was an Alchemy-side packaging bug, not a routing
bug by itself. The platform concern that remains is that a crashing/boot-looping
version still surfaced as `running` with non-null domains and Prisma edge 404s.

Live resources from the failed Next.js deploy:

```text
projectId:             proj_cmp7rry6n1w841af80wjmallh
projectName:           alchemy-prisma-nextjs-project
branchId:              br_cmp7rryx31w861af8aokf10ld
databaseId:            db_cmp7rs0cj1w8b1af8r35dn5co
computeServiceId:      cps_cmp7rs1ul1w8i1af8jn970dim
computeVersionId:      cpv_cmp7s5ohn1wat1af8zl7at7d1
foundryVersionId:      cv_4d06d3c6ea47
status:                running
previewDomain:         cv-4d06d3c6ea47.ewr.prisma.build
serviceEndpointDomain: https://cmp7rs1ul1w8i1af8jn970dim.ewr.prisma.build
```

Management API confirms the version is running:

```sh
curl -sS \
  -H "Authorization: Bearer $PRISMA_SERVICE_TOKEN" \
  "$PRISMA_API_URL/v1/compute-services/versions/cpv_cmp7s5ohn1wat1af8zl7at7d1"
```

Sanitized response:

```json
{
  "id": "cpv_cmp7s5ohn1wat1af8zl7at7d1",
  "type": "compute-version",
  "foundryVersionId": "cv_4d06d3c6ea47",
  "status": "running",
  "previewDomain": "cv-4d06d3c6ea47.ewr.prisma.build",
  "createdAt": "2026-05-16T03:22:06.012Z"
}
```

Management API also confirms the service points at that version:

```json
{
  "id": "cps_cmp7rs1ul1w8i1af8jn970dim",
  "type": "compute-service",
  "name": "alchemy-prisma-nextjs",
  "projectId": "proj_cmp7rry6n1w841af80wjmallh",
  "latestVersionId": "cpv_cmp7s5ohn1wat1af8zl7at7d1",
  "serviceEndpointDomain": "https://cmp7rs1ul1w8i1af8jn970dim.ewr.prisma.build",
  "region": {
    "id": "us-east-1",
    "name": "us-east-1"
  }
}
```

Observed public URL checks:

```sh
curl -i https://cv-4d06d3c6ea47.ewr.prisma.build/
curl -i https://cmp7rs1ul1w8i1af8jn970dim.ewr.prisma.build/
```

Both returned HTTP 404 with:

```html
<title>Service not found</title>
There is no service on this URL.
```

This still reproduced several minutes after promotion, so it did not look like
a short DNS/edge propagation delay during the smoke.

Compute logs from `project-compute` showed the runtime repeatedly rebooting:

```text
starting bun with entrypoint: bundle/examples/prisma-nextjs/server.js
Cannot find module '@swc/helpers/_/_interop_require_default'
Application exit with 0x100
reboot: Restarting system
```

Alchemy fix: materialize Bun's `.bun/node_modules` package aliases into a normal
`node_modules` tree before archiving Next standalone output. A fresh deploy after
that fix served successfully:

```text
projectId:        proj_cmp7w72ro1wuo1af8cpuy5so8
computeServiceId: cps_cmp7w765s1wv01af8ksmf485g
computeVersionId: cpv_cmp7w7hoj1wvg1af8cqqyglfa
foundryVersionId: cv_9b18ed1deb77
service URL:      https://cmp7w765s1wv01af8ksmf485g.ewr.prisma.build
```

Verified:

```sh
curl -fsS https://cmp7w765s1wv01af8ksmf485g.ewr.prisma.build/
curl -fsS https://cmp7w765s1wv01af8ksmf485g.ewr.prisma.build/api/health
```

`/api/health` returned JSON with `ok: true`, the Prisma project/database IDs,
and the expected environment flags.

Notes from `project-compute`:

- `sdk/src/polling.ts` considers a version deploy successful when the
  Management API reports `status === "running"` and `previewDomain` is non-null.
- It does not perform an HTTP reachability check against `previewDomain`.
- Alchemy initially matched that SDK behavior, which is why this slipped
  through until the public URL was manually checked.

Expected platform behavior:

- If a version process exits during boot, the Management API should not report a
  plain healthy `running` state, or it should expose a separate readiness /
  health signal that deploy clients can poll.
- If edge routing intentionally returns "Service not found" for boot-looping
  versions, that behavior should be documented so clients do not confuse it with
  DNS/route propagation.

Likely places to inspect:

- Foundry version start path that sets `previewDomain`.
- Foundry endpoint upsert path used by
  `packages/interactors/src/compute/service.ts` `promoteComputeService`.
- Edge/router state for `cv_4d06d3c6ea47.ewr.prisma.build` and
  `cmp7rs1ul1w8i1af8jn970dim.ewr.prisma.build`.

## 2. Stopped Compute Version Cannot Be Deleted

Severity: high

Impact: a deployed Compute app cannot be fully destroyed through the public API.
The version is already `stopped`, but both version delete endpoints return HTTP
500. Because the version remains active in control-plane state, the compute
service and project cannot be deleted.

Live resources from the failed smoke:

```text
projectId:        proj_cmp7dc5wu1tv51af8j07x4b76
projectName:      alchemy-compute-mp7dc4y7
computeServiceId: cps_cmp7dc6mu1tv71af83lxuatvp
computeVersionId: cpv_cmp7dc8h91tvd1af8sytxctbs
foundryVersionId: cv_174f812a6342
status:           stopped
serviceEndpoint:  https://cmp7dc6mu1tv71af83lxuatvp.cdg.prisma.build
previewDomain:    cv-174f812a6342.ewr.prisma.build
```

The same stopped-version delete failure reproduced again with the Next.js
example project on 2026-05-16:

```text
projectId:        proj_cmp7rry6n1w841af80wjmallh
computeServiceId: cps_cmp7rs1ul1w8i1af8jn970dim
computeVersionId: cpv_cmp7s5ohn1wat1af8zl7at7d1
foundryVersionId: cv_4d06d3c6ea47
status:           stopped
```

For that second project:

- `POST /v1/compute-services/versions/cpv_cmp7s5ohn1wat1af8zl7at7d1/stop`
  returned 409 because the version was already `stopped`.
- `DELETE /v1/compute-services/versions/cpv_cmp7s5ohn1wat1af8zl7at7d1`
  returned HTTP 500.
- `DELETE /v1/versions/cpv_cmp7s5ohn1wat1af8zl7at7d1` returned HTTP 500.
- `DELETE /v1/compute-services/cps_cmp7rs1ul1w8i1af8jn970dim` returned 409.
- `DELETE /v1/projects/proj_cmp7rry6n1w841af80wjmallh` returned 409.

It reproduced a third time after the Alchemy Next.js archive fix, with a healthy
Next app that did serve public traffic before destroy:

```text
projectId:        proj_cmp7w72ro1wuo1af8cpuy5so8
computeServiceId: cps_cmp7w765s1wv01af8ksmf485g
computeVersionId: cpv_cmp7w7hoj1wvg1af8cqqyglfa
foundryVersionId: cv_9b18ed1deb77
status:           stopped
```

For that third project:

- `alchemy deploy --stage smoke_next_fix_1778908507 --yes` succeeded.
- `curl /` returned the rendered Next.js page.
- `curl /api/health` returned `ok: true`.
- `alchemy destroy --stage smoke_next_fix_1778908507 --yes` stopped the version,
  then both delete routes returned HTTP 500.

It reproduced again on 2026-05-17 with the
`examples/prisma-tanstack-start` app. This app uses TanStack Start plus Prisma
Next seed/query code and deployed successfully before destroy:

```text
projectId:        proj_cmp9tzfup2ak01af8dv29ui9x
branchId:         br_cmp9tzgu02ak41af8a861jgf3
databaseId:       db_cmp9tzhm52ak51af8k5zhmspc
connectionId:     con_cmp9tzioo2aka1af8atd7cauy
computeServiceId: cps_cmp9tzkbg2ake1af8e601i9aj
computeVersionId: cpv_cmp9u0dws2alj1af8pvbwolw4
serviceEndpoint:  https://cmp9tzkbg2ake1af8e601i9aj.ewr.prisma.build
```

Deploy succeeded:

```text
✓ App (Prisma.ComputeApp) updated
✓ Connection (Prisma.Connection) updated
✓ MainBranch (Prisma.Branch) updated
✓ Postgres (Prisma.Database) updated
✓ Project (Prisma.Project) updated
✓ SharedFlag (Prisma.EnvironmentVariable) updated
```

Destroy then failed after `SharedFlag` was deleted. The Compute version had
already reached `stopped`, but both deletion attempts returned HTTP 500:

```text
Failed to delete Prisma compute version 'cpv_cmp9u0dws2alj1af8pvbwolw4'
while it was in status 'stopped'.
Service-scoped delete failed: Prisma API returned HTTP 500: Internal Server Error.
Global delete fallback failed: Prisma API returned HTTP 500: Internal Server Error.
```

This confirms the blocker is framework-independent: it affects the minimal
Compute smoke app, the fixed Next.js app, and the TanStack Start + Prisma Next
app.

Repro:

```sh
export PRISMA_SERVICE_TOKEN=...
export PRISMA_API_URL=https://api.prisma.io

curl -sS \
  -H "Authorization: Bearer $PRISMA_SERVICE_TOKEN" \
  "$PRISMA_API_URL/v1/versions/cpv_cmp7dc8h91tvd1af8sytxctbs"

curl -i -X DELETE \
  -H "Authorization: Bearer $PRISMA_SERVICE_TOKEN" \
  "$PRISMA_API_URL/v1/versions/cpv_cmp7dc8h91tvd1af8sytxctbs"

curl -i -X DELETE \
  -H "Authorization: Bearer $PRISMA_SERVICE_TOKEN" \
  "$PRISMA_API_URL/v1/compute-services/versions/cpv_cmp7dc8h91tvd1af8sytxctbs"
```

Observed `GET /v1/versions/{id}`:

```json
{
  "id": "cpv_cmp7dc8h91tvd1af8sytxctbs",
  "type": "compute-version",
  "url": "https://api.prisma.io/v1/versions/cpv_cmp7dc8h91tvd1af8sytxctbs",
  "foundryVersionId": "cv_174f812a6342",
  "status": "stopped",
  "previewDomain": "cv-174f812a6342.ewr.prisma.build",
  "envVars": {
    "GREETING": "hello from alchemy"
  },
  "portMapping": {
    "http": 8080
  },
  "createdAt": "2026-05-15T20:27:17.614Z"
}
```

Observed delete response from both delete endpoints:

```json
{
  "error": {
    "code": "internal-server-error",
    "message": "Internal Server Error",
    "hint": "Retry after a short delay. If the problem persists, contact support."
  }
}
```

I retried deletion 12 times over about 2 minutes. Every attempt saw:

```text
get=stopped delete=500 message=Internal Server Error
```

Retried again at 2026-05-15T20:46:37Z against the same IDs. The version still
reported `stopped`; both delete endpoints still returned HTTP 500; service and
project deletion still returned HTTP 409.

Tried a no-new-resource workaround at 2026-05-15T20:50:53Z:

- `POST /v1/compute-services/versions/{versionId}/start` returned HTTP 502.
- The version stayed `stopped` after repeated polling.
- `POST /v1/compute-services/{serviceId}/promote` returned HTTP 409 because the
  Foundry version is `stopped` and must be `running`.
- `POST /v1/compute-services/versions/{versionId}/stop` returned HTTP 409
  because the version is already `stopped`.
- Both delete endpoints still returned HTTP 500.

Expected:

- A stopped Compute version should be deletable.
- Per `pdp-control-plane/packages/interactors/src/compute/version.ts`, delete
  should delete the Foundry version, clear `computeService.latestVersionId` if
  it points at the version, then soft-delete the ComputeVersion record.

Notes from the reference repo:

- `packages/management-api-sdk/src/api.d.ts` documents version deletion as
  allowed when the version is `stopped` or `new`.
- `packages/interactors/src/compute/version.ts` documents and implements
  clearing `latestVersionId` inside the delete transaction.

Likely control-plane paths to inspect:

- `services/management-api/routes/v1/versions.ts`
- `services/management-api/routes/v1/compute-services.ts`
- `services/management-api/routes/v1/version-handlers.ts`
- `services/management-api/lib/errorHandler.ts`
- `packages/interactors/src/compute/version.ts`
- `packages/foundry-client/src/client.ts`
- `packages/foundry-client/src/commands.ts`

In the cloned control-plane, `deleteComputeVersion` delegates to
`deleteVersionWithRecovery`. That helper only treats Foundry delete as recovered
when Foundry `getVersion` returns 404 after a delete failure. In this live case,
the Management API reports the version as `stopped`, but delete still throws a
500, so the interactor never reaches the transaction that clears
`computeService.latestVersionId` and soft-deletes the version.

Deeper trace through the cloned source:

1. Both public routes call the same handler:
   - `DELETE /v1/versions/:versionId`
   - `DELETE /v1/compute-services/versions/:versionId`
   - Both delegate to `services/management-api/routes/v1/version-handlers.ts`
     `handleDeleteVersion`.
2. `handleDeleteVersion` calls
   `packages/interactors/src/compute/version.ts` `deleteComputeVersion`.
3. `deleteComputeVersion` calls `deleteVersionWithRecovery`.
4. `deleteVersionWithRecovery` calls Foundry:
   `DELETE /compute-versions/{foundryVersionId}`.
5. If Foundry returns a non-2xx status below 500, `FoundryClient.send` returns a
   typed `FoundryFailure`. A 409 is mapped to `ConflictFailure`, which becomes a
   public HTTP 409 with a useful hint.
6. If Foundry returns HTTP 500+, `packages/foundry-client/src/client.ts` throws
   `FoundryException` instead of returning `FoundryFailure`.
7. `deleteVersionWithRecovery` catches that exception, then performs a recovery
   `GET /compute-versions/{foundryVersionId}`. It only recovers if that GET
   returns 404.
8. In the live stuck case, the version still reports `stopped`, so recovery does
   not trigger and the original `FoundryException` is thrown.
9. The Management API global `errorHandler` converts thrown exceptions to HTTP
   500 and intentionally replaces the message with `Internal Server Error`.

So the public 500 is likely not thrown by the route itself. It is almost
certainly a Foundry delete failure that survives the recovery check. The useful
diagnostic should be in Management API logs/Sentry/OTel for the failing request:

- exception class/message from `FoundryException`
- `foundry.response.body`
- `foundry.error`
- `foundry.error_detail`
- `http.response.status_code`
- `url.path = /compute-versions/cv_174f812a6342`

Those attributes are recorded in `packages/foundry-client/src/client.ts` before
the exception bubbles to the global handler.

I also checked for alternate public cleanup paths:

- `project-compute/sdk/src/compute-client.ts` `destroyVersion()` gets the
  version, skips stop if it is already `stopped`, then calls `deleteVersion()`.
- `project-compute/sdk/src/compute-client.ts` `destroyService()` stops active
  versions, deletes versions, then deletes the service.
- `project-compute/sdk/src/api-client.ts` maps version delete to
  `DELETE /v1/compute-services/versions/{versionId}`.
- `pdp-control-plane/services/management-api/routes/admin.ts` does not expose a
  compute-version force-delete endpoint.

So this appears to be a real platform blocker for every public client using the
documented destroy flow, not an Alchemy-specific route choice.

Suggested regression coverage in `pdp-control-plane`:

- Add a `deleteComputeVersion` interactor test where Foundry delete returns a
  non-409/500-style error, Foundry still returns the version with status
  `stopped`, and assert the desired behavior explicitly. Today the existing
  test named `deleteComputeVersion throws when Foundry delete fails and the
  version still exists` covers the current 500 behavior, but not the
  stopped-version case that public docs say should be deletable.
- Add route-level coverage for both `DELETE /versions/:versionId` and
  `DELETE /compute-services/versions/:versionId` so both public paths agree
  once the interactor behavior is fixed.

Concrete source-level mismatch:

- `packages/foundry-client/src/api.d.ts` documents Foundry version delete as
  permanently deleting a version and says it is only permitted when status is
  `new` or `stopped`.
- `packages/interactors/src/compute/version.ts` only recovers a failed Foundry
  delete when `getVersion(foundryVersionId)` returns 404 afterward.
- `packages/interactors/src/compute/version.test.ts` has a test named
  `deleteComputeVersion throws when Foundry delete fails and the version still
  exists` that currently preserves the 500 behavior even if the version remains
  visible.

The team probably wants a new test specifically for:

```text
local ComputeVersion exists
Foundry version exists with status stopped
Foundry DELETE returns a non-409 failure
Foundry GET still returns status stopped
expected behavior: either recover and soft-delete local ComputeVersion, or
return a typed non-500 failure with enough metadata to clean up manually
```

That would force an explicit product decision instead of leaking a generic
Management API 500 to every public client.

Concrete test sketch for the control-plane repo:

```ts
test("deleteComputeVersion handles a stopped Foundry version when delete returns 500", async () => {
  const { workspace, service } = await createServiceFixture();
  const actor = makeWorkspaceActor(workspace.id);
  const foundryClient = createMockFoundryClient();
  const { localVersion, foundryVersion } = await createLinkedVersion(
    foundryClient,
    {
      computeServiceId: service.id,
      workspaceId: workspace.id,
    },
  );

  foundryClient.setComputeVersionStatus(foundryVersion.id, "stopped");
  foundryClient.failNextWith(
    {
      type: "exception",
      statusCode: 500,
      message: "Foundry unavailable while deleting stopped version",
    },
    {
      method: "DELETE",
      pathname: `/compute-versions/${foundryVersion.id}`,
    },
  );

  const [failure, result] = await deleteComputeVersion(
    { prisma: db.prisma, resolveFoundryClient: () => foundryClient },
    { versionId: localVersion.id },
    actor,
  );

  // Product decision:
  // Option A: recover and soft-delete local ComputeVersion.
  expect(failure).toBeNull();
  expect(result).toEqual({ deleted: true });

  // Option B: return a typed, non-500 cleanup failure instead of throwing an
  // internal error from the Management API route.
});
```

Alchemy mitigation in this worktree:

- `destroyComputeVersion` first tries
  `DELETE /v1/compute-services/versions/{versionId}`.
- If that fails with a non-404 error, it falls back to
  `DELETE /v1/versions/{versionId}`.
- During the failed live smoke both endpoints returned 500, so this does not
  resolve the stuck resource by itself; it only means Alchemy can recover if one
  route is fixed before the other.
- `destroyComputeProject` discovers all Compute services in a project, destroys
  each service's versions and service record, then deletes the project. This
  means cleanup can be retried from just the stranded project ID once the
  platform delete bug is fixed.
- `packages/alchemy/test/Prisma/ComputeApp.live.test.ts` includes a cleanup-only
  live test so the stranded project/service/version can be retried after the
  platform fix without deploying another app:

  ```sh
  export PRISMA_SERVICE_TOKEN=...
  export PRISMA_CLEANUP_PROJECT_ID=proj_cmp7dc5wu1tv51af8j07x4b76
  export PRISMA_CLEANUP_COMPUTE_SERVICE_ID=cps_cmp7dc6mu1tv71af83lxuatvp # optional final check
  export PRISMA_CLEANUP_COMPUTE_VERSION_ID=cpv_cmp7dc8h91tvd1af8sytxctbs # optional direct retry
  bun run --cwd examples/prisma-compute cleanup:live
  ```

## 3. Service And Project Deletion Are Blocked After Version Is Stopped

Severity: high, caused by bug 1

Impact: `alchemy destroy`, `compute services destroy`, or any integration that
does the documented stop -> delete version -> delete service flow can strand an
entire project.

Repro:

```sh
curl -i -X DELETE \
  -H "Authorization: Bearer $PRISMA_SERVICE_TOKEN" \
  "$PRISMA_API_URL/v1/compute-services/cps_cmp7dc6mu1tv71af83lxuatvp"

curl -i -X DELETE \
  -H "Authorization: Bearer $PRISMA_SERVICE_TOKEN" \
  "$PRISMA_API_URL/v1/projects/proj_cmp7dc5wu1tv51af8j07x4b76"
```

Observed service delete:

```json
{
  "error": {
    "code": "client-error",
    "message": "Cannot delete ComputeService: active compute versions exist. Please stop and delete all compute versions first.",
    "hint": "The resource already exists or is in a conflicting state."
  }
}
```

Observed project delete:

```json
{
  "error": {
    "code": "client-error",
    "message": "Cannot delete project: active compute versions exist. Please stop and delete all compute versions first.",
    "hint": "The resource already exists or is in a conflicting state."
  }
}
```

Expected:

- Once the only version is stopped and deleted, service deletion should succeed.
- Once service deletion succeeds, project deletion should succeed.

Current blocker:

- Version deletion never succeeds because of bug 1, so both service and project
  remain blocked.

## 4. Compute Service Delete Documentation Does Not Match Behavior

Severity: medium

The public SDK docs say:

```text
Deletes a compute service. All compute versions under the service must already
be stopped or deleted.
```

Actual behavior rejects a service whose only version is `stopped`:

```text
Cannot delete ComputeService: active compute versions exist. Please stop and
delete all compute versions first.
```

The control-plane interactor also appears to require soft-deleted versions, not
merely stopped versions:

- `packages/interactors/src/compute/service.ts` guards against active
  non-deleted compute versions before deleting the service.

Expected:

- Either service delete should accept stopped versions as documented and delete
  or soft-delete them, or the API docs should say every version must be deleted
  first.

## 5. Stop Version Is Not Idempotent For Already-Stopped Versions

Severity: low to medium

Observed after the version had reached `stopped`:

```json
{
  "error": {
    "code": "client-error",
    "message": "Foundry HTTP 409: Cannot stop compute version in \"stopped\" state ...",
    "hint": "The compute version must be running or provisioning to be stopped."
  }
}
```

This is defensible as an API choice, but it makes destroy flows more brittle.
For IaC-style destroy operations, idempotent stop would be better:

- `running` or `provisioning`: request stop and return success once stopped.
- `stopped`: return success/no-op.
- not found or already deleted: return 404 or success depending on the API's
  idempotency policy.

Alchemy works around this by treating conflict while stopping as best-effort
when the version is already not running, but platform-level idempotency would
make every client simpler.

## 6. `project-compute` SDK Env Var Payload Drift

Severity: medium

This is source-level contract drift between the two reference repos; I have not
seen it fail live from Alchemy.

The current `pdp-control-plane` Management API SDK says Compute version create
does not accept env vars in the deploy payload:

- `/v1/compute-services/{computeServiceId}/versions`
- `/v1/versions`

Both descriptions say environment variables are resolved from the attached
Branch and clients should manage env vars via `/v1/environment-variables`.
The request body schemas only include `portMapping`, `skipCodeUpload`, and
`computeServiceId` where applicable.

In `project-compute`, `ComputeClient.deploy()` / `updateEnv()` still pass
`envVars` into `createServiceVersion`, and tests assert that `envVars` appears
in the POST body:

- `sdk/src/compute-client.ts`
- `sdk/test/compute-client.test.ts`

Expected:

- Either `project-compute` should switch to the current env-var endpoint flow,
  or `pdp-control-plane`'s OpenAPI schema/docs should include `envVars` if the
  deploy payload remains supported.

Alchemy follows the current control-plane contract:

- `ComputeApp.env` reconciles `/v1/environment-variables` before creating a
  version.
- `ComputeVersionCreateInput` and `ServiceComputeVersionCreateInput` do not
  include `envVars`.

## Alchemy-Side Bugs Also Found

These are not Prisma platform bugs.

### Standalone `ComputeVersion` Used The Global Create Route

`ComputeApp` already followed the working `project-compute` deploy path and
created versions through:

```text
POST /v1/compute-services/{computeServiceId}/versions
```

The standalone Alchemy `ComputeVersion` resource was still using:

```text
POST /v1/versions
```

That may be a valid Management API helper route, but it did not match the SDK
deploy path that was proven during the live smoke. Fixed in this worktree:

- `packages/alchemy/src/Prisma/ComputeVersion.ts` now calls
  `createServiceComputeVersion(computeServiceId, body)`.
- `packages/alchemy/test/Prisma/Resources.test.ts` and
  `packages/alchemy/test/Prisma/ComputeVersion.test.ts` assert the scoped call.

### Prisma API Retry Delay Was Ambiguous

Alchemy's Prisma client already retried transient HTTP 408/429/5xx responses,
including DELETE requests, but the retry schedule used `Schedule.exponential(100)`.
Under the Effect test runtime that parked the retry for far longer than the
intended 100ms. Fixed in this worktree:

- `packages/alchemy/src/Prisma/Client.ts` now uses
  `Schedule.exponential("100 millis")`.
- `packages/alchemy/test/Prisma/Client.test.ts` proves
  `DELETE /v1/compute-services/versions/{versionId}` retries two HTTP 500
  responses and then succeeds under `TestClock`.

This does not solve the platform-side stopped-version delete bug by itself; it
does mean Alchemy has bounded transient retry coverage before reporting the
upstream blocker.

### Live Smoke Finalizer Lost `PrismaClient`

The live smoke test had a cleanup verifier inside an `Effect.ensuring`
finalizer. That verifier called `Prisma.getProject` / `Prisma.getComputeService`
but the finalizer did not have the `PrismaClient` service in scope, causing:

```text
Service not found: Prisma::PrismaClient
```

Fixed in this worktree:

- Keep finalizers limited to best-effort `stack.destroy()` and temp-dir cleanup.

### Failed Promotion Could Leave A New Version Dangling

While cross-checking against `project-compute/sdk/src/compute-client.ts`, I
found an Alchemy-side lifecycle parity bug: if `ComputeApp` created and started
a new version, then `promote` failed, the failed reconcile could leave the new
version behind because no Alchemy state is persisted after a reconcile failure.

The official Compute SDK handles this with a best-effort cleanup of the newly
created version. Fixed in this worktree:

- `ComputeApp` now best-effort stops/deletes a newly created version when
  promotion fails, then re-raises the original promote error.
- `packages/alchemy/test/Prisma/ComputeApp.test.ts` covers this path.
- Run post-destroy `expectGone(...)` checks only in the main provider-scoped
  test body.
- Patch: `packages/alchemy/test/Prisma/ComputeApp.live.test.ts`

This does not change the platform issue above: manual API cleanup still shows
the stopped version delete returning HTTP 500.

### Next.js Auto-Build Assumed Root Standalone Entrypoint

While building the complete Next.js example, I found an Alchemy-side auto-build
bug for monorepo apps. Next.js 16 standalone output in this workspace produced:

```text
.next/standalone/examples/prisma-nextjs/server.js
```

Alchemy's Next.js auto-build path previously assumed:

```text
.next/standalone/server.js
```

That meant a real Prisma Compute upload from a monorepo-style Next app could
archive the standalone output but point the manifest at the wrong entrypoint.
Fixed in this worktree:

- `ComputeBuild.ts` now detects a nested standalone `server.js` while ignoring
  `node_modules/**/server.js`.
- `packages/alchemy/test/Prisma/ComputeBuild.test.ts` covers the nested
  monorepo output shape.
- The `examples/prisma-nextjs` smoke confirmed auto-build returns
  `examples/prisma-nextjs/server.js`.

### Next.js Auto-Build Lost Bun Package Aliases During Archive

After comparing against the cloned `project-compute` demos and tailing the
failed Compute version's logs, I found the cause of the first Next.js
`Service not found` result:

```text
Cannot find module '@swc/helpers/_/_interop_require_default'
```

The Next standalone output built by Bun uses package-store aliases under:

```text
node_modules/.bun/node_modules/@swc/helpers
```

Those aliases work locally while symlinks are intact, but after Alchemy copied
and archived the standalone output, `next/dist/...` was materialized under the
app's nested `node_modules/next` path and no normal
`node_modules/@swc/helpers` package existed for module resolution.

Fixed in this worktree:

- `ComputeBuild.ts` now materializes Bun `.bun/node_modules` aliases into a
  normal `node_modules` tree before creating the Compute archive.
- The archive was unpacked locally and verified with:

  ```sh
  PORT=4303 bun /tmp/alchemy-next-fixed-archive-test/bundle/examples/prisma-nextjs/server.js
  ```

  It booted successfully.
- A fresh live deploy then served the Next page and `/api/health` from Prisma
  Compute.
- `packages/alchemy/test/Prisma/ComputeBuild.test.ts` covers the Bun alias
  materialization path.

### `alchemy dev` State Polluted Later Live Deploy/Destroy

This one is an Alchemy provider/dev-mode bug, not a Prisma platform bug.

After running `alchemy dev` in the Next.js example and then deploying/destroying
from the same directory, local state contained placeholder IDs like:

```text
dev:project:Project
dev:branch:MainBranch
dev:database:Postgres
dev:connection:Connection
```

Those placeholders leaked into later live operations:

```text
PrismaApiError: branchId: must be an optionally br prefixed cuid or cuid2
PrismaApiError: id: must be an optionally con prefixed cuid or cuid2
```

Fixed in this worktree:

- `Refs.ts` treats `dev:` IDs as unknown for unresolved live identity
  comparisons.
- Live providers ignore `dev:` output IDs before calling Prisma API `get`,
  `update`, or `delete` routes.
- Branch attachment helpers avoid sending `dev:branch:*` as a live `branchId`;
  they fall back to `branchGitName`/`main` for recovery.
- Providers with `dev:` outputs force an update so a live deploy can recover
  real IDs instead of reusing placeholders.
- `packages/alchemy/test/Prisma/Refs.test.ts` covers the placeholder behavior.

## Alchemy Dev Shutdown Wart Also Found

This one is not a Prisma platform bug.

Running the local Prisma Compute example works and the local app responds:

```sh
bun run --cwd examples/prisma-compute dev
curl -fsS http://localhost:8787/
# hello from alchemy dev
curl -fsS http://localhost:8787/health
# {"ok":true}
```

However, interrupting the dev process with `Ctrl-C` reproducibly prints:

```text
Internal error: directory mismatch for directory "/Users/aman/dev/work/alchemy-effect/packages/alchemy/tsconfig.json", fd 3. You don't need to do anything, but this indicates a bug.
```

Observed on 2026-05-16:

- The command exits with code 0.
- Port `8787` is clear afterward.
- `rg` does not find that message in this repository, `pdp-control-plane`, or
  `project-compute`, so it appears to come from Bun or the dev runtime watcher.

This does not block the Prisma provider, but it is visible DX noise during local
development.
