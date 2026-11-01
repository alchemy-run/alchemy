import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as sfs from "@distilled.cloud/stackit/sfs";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

// A lock costs nothing and needs no pool, so this suite runs ungated. The lock is
// project-wide, so every case holds one label and nothing else in the suite touches it.
const options = {
  tags: stackitTags("filestorage", "projectlock"),
  timeout: 180_000,
  exclusive: "stackit:sfs-project-lock",
} as const;

const Lock = () => Stackit.FileStorage.ProjectLock("LockUnderTest", {});

/** The lock's id, or `undefined` when the project has none. */
const observeLock = (projectId: string, region: string) =>
  sfs.getLock({ projectId, region }).pipe(
    Effect.map((response) => response.lockId),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

test.provider(
  "enable and disable the lock",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();
      expect(yield* observeLock(projectId, region)).toBeUndefined();

      const created = yield* stack.deploy(Lock());
      expect(created.lockId).toEqual(expect.any(String));
      expect(created.projectId).toEqual(projectId);
      expect(created.region).toEqual(region);

      // Out of band: this very lock is on the project.
      expect(yield* observeLock(projectId, region)).toEqual(created.lockId);

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(Lock());
      expect(plan.resources.LockUnderTest).toMatchObject({ action: "noop" });

      // Destroying it leaves the project deletable.
      yield* stack.destroy();
      expect(yield* observeLock(projectId, region)).toBeUndefined();
    }).pipe(logLevel),
  options,
);

test.provider(
  "a lock nobody here enabled is reported as unowned, and survives",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      // `ProjectLock` has no `list`, so `pnpm nuke` can't clear this one, and it would fail
      // every later run and block deleting the project. It goes whatever the assertions do.
      yield* Effect.acquireUseRelease(
        sfs.enableLock({ projectId, region }),
        (foreign) =>
          Effect.gen(function* () {
            expect(foreign.lockId).toEqual(expect.any(String));

            const error = yield* stack.deploy(Lock()).pipe(Effect.flip);
            expect(error._tag).toEqual("OwnedBySomeoneElse");
            expect(yield* observeLock(projectId, region)).toEqual(foreign.lockId);

            // Destroying a stack that doesn't own it doesn't remove someone's protection.
            yield* stack.destroy();
            expect(yield* observeLock(projectId, region)).toEqual(foreign.lockId);
          }),
        () => sfs.disableLock({ projectId, region }).pipe(Effect.ignore),
      );
      expect(yield* observeLock(projectId, region)).toBeUndefined();
    }).pipe(logLevel),
  options,
);
