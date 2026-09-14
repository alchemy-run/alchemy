# Containers audit

Scope: Container/ContainerApplication contracts, live and local providers, existing image/runtime fixtures, and the Containers SDK manual model. SDK API is maintained in `manual-specs/containers.json` because Cloudflare does not publish this control-plane resource in its API reference. Reviewed all eight SDK operations (application create/get/list/update/delete, rollout creation, registry credentials creation, registry listing).

## API coverage and fixes

- All persistent application request fields are represented: name, instances/maxInstances, scheduling policy, constraints, affinities, full configuration, immutable Durable Object attachment, and newly added jobs. Configuration includes image, instance type or explicit hardware, environment/secrets, labels, ports/network/DNS, entrypoint/command, observability/checks/SSH keys. `memoryMib` is the API's numeric hardware representation; desired memory is already supported through its string memory representation.
- `jobs` is creation-only. Changing it now requests delete-first replacement so a fixed application name or DO namespace cannot cause the new generation to adopt the old application and subsequently delete it. Both create paths send the option. API GET does not expose this flag, so it is retained as desired state rather than invented as an observed attribute. Full jobs lifecycle remains gated by the account capability.
- Freshly observed application version/scaling changes now invalidate the saved configuration fingerprint. Previously the provider copied the saved hash onto the new observation and could skip repairing an out-of-band scaling change. Live regression changes maxInstances via SDK and triggers reconcile with unchanged desired scaling/configuration, proving the desired limit is restored.
- Explicit Dockerfile paths now resolve relative to `context` in both live and local providers, matching the documented contract. Previously each path was resolved against process cwd, so `{ context: '/some/context', dockerfile: 'Dockerfile' }` failed before build. New shared fixture verifies the path in actual live and local deployments.
- Existing ownership/read-after-delete, precreate-to-DO-attachment recovery, immutable digest pinning, no-op image rebuild, rollout, local-to-live IDs and bounded readiness behavior reviewed. A live duplicate-name probe exposed HTTP400 `Invalid input: An application with the name <name> already exists in this account.` Added ContainerApplicationAlreadyExists to the maintained SDK model and replaced the consumer message heuristic with its typed catch. GET/list use specific not-found/unsupported-route handling.
- Existing ContainerApplication image/recovery tests now use <=120-second per-test caps and <=8 repeats. Existing local HTTP test uses <=90-second test and bounded readiness probes.

## Live evidence

All tests deploy real Docker images/applications and verify with the actual Containers SDK. No mocked provider/client tests were added.

1. New configuration suite: defaults, in-place scaling update, out-of-band scaling repair, deleted application recreation, already-deleted destruction, typed jobs entitlement probe. **2 passed, 1 gated**, 25.2s; log `packages/alchemy/.alchemy/log/test/2026-09-13T07-45-07-pid30184.log`.
2. Extended new suite including actual external Dockerfile build/deploy: all three live cases passed, one jobs lifecycle gated. Combined run also contained a local test blocked by an unrelated intermediate Vectorize RPC registration edit; log `packages/alchemy/.alchemy/log/test/2026-09-13T07-46-12-pid32123.log`.
3. Existing ContainerApplication suite: **5 passed, 0 failures**, 97.6s, covering live enumeration, prepushed digest/tag image consumption, identical image no-op, legacy digest state migration, and deleting/recreating an application to attach its Durable Object while preserving the image digest. Log `packages/alchemy/.alchemy/log/test/2026-09-13T07-44-38-pid29546.log`.

Jobs `true` was attempted against the real API. Exact rejection: Cloudflare code **1000**, `account does not have the capability to create "jobs" based policies. You might need the APPLICATION_JOBS_POLICY capability on the account.` The SDK now exposes **ContainerJobsNotEnabled**. The lifecycle fixture is gated behind **CLOUDFLARE_TEST_CONTAINER_JOBS** and the default ungated probe asserts that typed failure. The probe first deploys a real source image and cleans it up; an unexpected successful jobs application is also cleaned up before failing the entitlement assertion.

Cloudflare GET normalizes instanceType into hardware allocation rather than echoing `lite`; the test checks desired `lite` on deployment attributes and independently verifies actual image/default scaling. It does not claim to exercise a running instance's CPU quota.

## SDK change

Changed the maintained Smithy manual model `submodules/distilled/packages/cloudflare/manual-specs/containers.json` to add capability/conflict error shapes and the create-operation error union; regenerated **only containers** with `bun scripts/generate.ts --resource containers`. Generated `src/services/containers.ts` now exports the typed error. Core generator CLI explicitly states RFC6902 patches run in convert, never generate; manual models bypass convert, so a patch file would be silently unused. No manual edits to generated SDK and no agent build/typecheck.

## Local feasibility

Existing cloudflare-runtime starts actual Docker containers under workerd Durable Objects; image execution, env injection, HTTP ports and lifecycle are locally feasible. The local provider prepares Docker image build/pull descriptors; application IDs/configuration/scheduling values are local placeholders. Cloudflare global autoscaling, placement, registry propagation, rollouts, billing, and jobs account-policy scheduling are not reproduced by a single local Docker engine. The new relative-Dockerfile fix applies to this real local path too.

The initial local runs could not start any provider: an intermediate VectorizeMetadataIndex registration accidentally passed `generateLocalId` as RPC server URL, causing spawner400. Coordinator identified and corrected that separate edit. Fresh local verification is recorded below after completion.

## References

- [Cloudflare Containers architecture](https://developers.cloudflare.com/containers/concepts/architecture/)
- [Container setup and Docker deployment](https://developers.cloudflare.com/containers/get-started/)
- [Containers overview and runtime API](https://developers.cloudflare.com/containers/)

Fresh local run after coordinator corrected the unrelated RPC registration: **2 passed, 0 failures**, 13.3s. Both the explicit relative-Dockerfile local deployment and actual Docker-backed container HTTP roundtrip pass with real workerd/Docker. Log `packages/alchemy/.alchemy/log/test/2026-09-13T07-48-07-pid33658.log`.

Final duplicate/conflict and configuration verification: **4 passed, 1 gated, 0 failures**, 30.1s. Log `packages/alchemy/.alchemy/log/test/2026-09-13T07-50-20-pid35859.log`. Across the final distinct container suites: **11 passed, 1 gated**, including actual Docker/workerd HTTP execution.

## Final readiness deadline regression

StartContainer now bounds each complete phase (8s instance acquisition,20s port readiness), including time consumed by five-second probes. The request transport retry runs only after readiness succeeds, preventing its three retries from multiplying the20s readiness budget.

Actual fixture `test/Cloudflare/Container/ReadinessTimeout.local.test.ts` starts a real Docker Bun HTTP server that accepts connections but never returns a response, accessed through real workerd/DO. It asserts HTTP503 containing the20s readiness deadline and total request time<35s. Initial post-fix run passed after two retries (60.8s total); log08-37-34-pid71684. Clean retry-disabled confirmation after coordinator rebuild passed1/1 in27.2s, no retries, log08-40-04-pid72669. Regular real local echo-container fixture passed1/1 in13.6s, log08-25-25-pid64756.
