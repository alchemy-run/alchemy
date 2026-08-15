import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as projects from "@distilled.cloud/vercel/projects";
import * as rolling_release from "@distilled.cloud/vercel/rolling_release";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Deterministic host-project names — one per test so concurrently running
// tests never fight over a fixture.
const HOST_LIFECYCLE = "alchemy-rolling-release-host-lifecycle";
const HOST_PROBE = "alchemy-rolling-release-host-probe";

const teamScopeOf = Effect.gen(function* () {
  const { teamId } = yield* Vercel.VercelEnvironment.current;
  return teamId === undefined ? {} : { teamId };
});

// Out-of-band host-project fixture (NOT the Vercel.Project resource — these
// tests must not depend on a concurrently-owned provider). Delete-if-exists
// first so an interrupted previous run can't wedge the deterministic name.
const ensureHostProject = (name: string, scope: { teamId?: string }) =>
  Effect.gen(function* () {
    yield* projects
      .deleteProject({ idOrName: name, ...scope })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
    const created = yield* projects.createProject({ name, ...scope });
    return created.id;
  });

// Finalizer-safe (used with `Effect.ensuring`): never fails.
const deleteHostProject = (name: string, scope: { teamId?: string }) =>
  projects.deleteProject({ idOrName: name, ...scope }).pipe(Effect.ignore);

test.provider(
  "create, no-op, update, and destroy a rolling release config",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* teamScopeOf;
      const projectId = yield* ensureHostProject(HOST_LIFECYCLE, scope);
      yield* Effect.gen(function* () {
        yield* stack.destroy();

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.RollingRelease("Rollout", {
              project: projectId,
              advancementType: "manual-approval",
              stages: [
                { targetPercentage: 10, requireApproval: true },
                { targetPercentage: 100 },
              ],
            });
          }),
        );
        expect(created.projectId).toEqual(projectId);
        expect(created.target).toEqual("production");
        expect(created.advancementType).toEqual("manual-approval");
        expect(created.stages).toEqual([
          { targetPercentage: 10, requireApproval: true },
          { targetPercentage: 100 },
        ]);
        expect(created.canaryResponseHeader).toEqual(false);

        // Out-of-band verification via distilled.
        const observed = yield* rolling_release.getRollingReleaseConfig({
          idOrName: projectId,
          ...scope,
        });
        expect(observed.rollingRelease).not.toBeNull();
        expect(observed.rollingRelease?.target).toEqual("production");
        expect(observed.rollingRelease?.stages?.length).toEqual(2);

        // No-op redeploy: same config, converges without drift.
        const second = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.RollingRelease("Rollout", {
              project: projectId,
              advancementType: "manual-approval",
              stages: [
                { targetPercentage: 10, requireApproval: true },
                { targetPercentage: 100 },
              ],
            });
          }),
        );
        expect(second.stages).toEqual(created.stages);

        // Update in place: automatic advancement + canary header.
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.RollingRelease("Rollout", {
              project: projectId,
              advancementType: "automatic",
              stages: [
                { targetPercentage: 25, duration: 5 },
                { targetPercentage: 100 },
              ],
              canaryResponseHeader: true,
            });
          }),
        );
        expect(updated.advancementType).toEqual("automatic");
        expect(updated.stages).toEqual([
          { targetPercentage: 25, duration: 5 },
          { targetPercentage: 100 },
        ]);
        expect(updated.canaryResponseHeader).toEqual(true);

        yield* stack.destroy();
        // Live-verified: a deleted config reads back as null.
        const afterDestroy = yield* rolling_release.getRollingReleaseConfig({
          idOrName: projectId,
          ...scope,
        });
        expect(afterDestroy.rollingRelease).toBeNull();

        // Idempotent destroy: a second destroy of the (now empty) stack
        // must not fail even though the config is gone.
        yield* stack.destroy();
      }).pipe(Effect.ensuring(deleteHostProject(HOST_LIFECYCLE, scope)));
    }).pipe(logLevel),
);

// Ungated probes: billing entitlement surface + the patched PATCH body.
// These pin (a) the typed billing union, and (b) that the distilled
// requestBody patch actually puts the body on the wire (the API validates
// the stages it receives), at near-zero cost.
test.provider(
  "billing status reports a known entitlement reason; invalid stages are a typed BadRequest",
  () =>
    Effect.gen(function* () {
      const scope = yield* teamScopeOf;
      const projectId = yield* ensureHostProject(HOST_PROBE, scope);
      yield* Effect.gen(function* () {
        const billing = yield* rolling_release.getRollingReleaseBillingStatus({
          idOrName: projectId,
          ...scope,
        });
        expect([
          "plan_not_supported",
          "unlimited_slots",
          "no_available_slots",
          "available_slots",
        ]).toContain((billing as { reason: string }).reason);

        // A config whose final stage is not 100% is rejected with a typed
        // BadRequest (live-verified `invalid_request`). The body reaching
        // the wire at all proves the requestBody patch.
        const invalid = yield* Effect.result(
          rolling_release.updateRollingReleaseConfig({
            idOrName: projectId,
            enabled: true,
            advancementType: "manual-approval",
            stages: [{ targetPercentage: 10 }],
            ...scope,
          }),
        );
        if (Result.isSuccess(invalid)) {
          return yield* Effect.die(
            "updateRollingReleaseConfig unexpectedly accepted a config without a final 100% stage",
          );
        }
        expect(invalid.failure._tag).toBe("BadRequest");
      }).pipe(Effect.ensuring(deleteHostProject(HOST_PROBE, scope)));
    }).pipe(logLevel),
);
