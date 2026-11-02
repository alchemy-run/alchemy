import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as sfs from "@distilled.cloud/stackit/sfs";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import {
  cheapestPerformanceClass,
  expectGone,
  observePool,
  poolProps,
  slow,
} from "./fileStorage.ts";

const { test } = makeStackitTest();

// One pool for at least a started hour (see `fileStorage.ts`). `snaplockRetentionHours` is
// not exercised: an immutable snapshot can't be deleted until its retention ends, and it
// would keep the billed pool alive until then.
const options = { tags: stackitTags("filestorage", "snapshot"), timeout: 3_600_000 } as const;

const app = (
  base: Stackit.FileStorage.ResourcePoolProps,
  snapshot: Omit<Stackit.FileStorage.ResourcePoolSnapshotProps, "resourcePoolId">,
) =>
  Effect.gen(function* () {
    const pool = yield* Stackit.FileStorage.ResourcePool("SnapshotPool", base);
    return {
      pool,
      snapshot: yield* Stackit.FileStorage.ResourcePoolSnapshot("SnapshotUnderTest", {
        resourcePoolId: pool.resourcePoolId,
        ...snapshot,
      }),
    };
  });

/** The names of a pool's snapshots, out of band. */
const snapshotNames = (projectId: string, region: string, resourcePoolId: string) =>
  sfs
    .listResourcePoolSnapshots({ projectId, region, resourcePoolId })
    .pipe(
      Effect.map(({ resourcePoolSnapshots }) =>
        (resourcePoolSnapshots ?? []).map((snapshot) => snapshot.snapshotName),
      ),
    );

test.provider.skipIf(slow)(
  "take, comment, rename in place and delete a snapshot",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const performanceClass = yield* cheapestPerformanceClass;
      const base = poolProps(region, performanceClass);
      yield* stack.destroy();

      const created = yield* stack.deploy(app(base, { comment: "first" }));
      const resourcePoolId = created.pool.resourcePoolId;
      const { snapshot } = created;
      expect(snapshot.snapshotName).toMatch(/^[a-z0-9-]+$/);
      expect(snapshot.resourcePoolId).toEqual(resourcePoolId);
      expect(snapshot.projectId).toEqual(projectId);
      expect(snapshot.region).toEqual(region);
      expect(snapshot.comment).toEqual("first");
      expect(snapshot.snaplockExpiryTime).toBeUndefined();

      // Out of band: the snapshot is on the pool.
      const fetched = yield* sfs.getResourcePoolSnapshot({
        projectId,
        region,
        resourcePoolId,
        snapshotName: snapshot.snapshotName,
      });
      expect(fetched.resourcePoolSnapshot?.comment).toEqual("first");
      expect(fetched.resourcePoolSnapshot?.resourcePoolId).toEqual(resourcePoolId);

      // `list` enumerates it, by its generated name in a pool Alchemy owns.
      const provider = yield* Provider.findProvider(Stackit.FileStorage.ResourcePoolSnapshot);
      const listed = yield* provider.list();
      expect(
        listed.find(
          (entry) =>
            entry.resourcePoolId === resourcePoolId && entry.snapshotName === snapshot.snapshotName,
        )?.comment,
      ).toEqual("first");

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(app(base, { comment: "first" }));
      expect(plan.resources.SnapshotUnderTest).toMatchObject({ action: "noop" });

      // The comment updates in place, as the same capture.
      const commented = yield* stack.deploy(app(base, { comment: "second" }));
      expect(commented.snapshot.comment).toEqual("second");
      expect(commented.snapshot.createdAt).toEqual(snapshot.createdAt);

      // So does the name: replacing would capture different content.
      const name = "alchemy-test-snapshot-renamed";
      const renamePlan = yield* stack.plan(app(base, { name, comment: "second" }));
      expect(renamePlan.resources.SnapshotUnderTest).toMatchObject({ action: "update" });
      const renamed = yield* stack.deploy(app(base, { name, comment: "second" }));
      expect(renamed.snapshot.snapshotName).toEqual(name);
      expect(renamed.snapshot.createdAt).toEqual(snapshot.createdAt);
      const names = yield* snapshotNames(projectId, region, resourcePoolId);
      expect(names).toContain(name);
      expect(names).not.toContain(snapshot.snapshotName);

      // Clearing the comment leaves the snapshot where it is.
      const cleared = yield* stack.deploy(app(base, { name }));
      expect(cleared.snapshot.comment ?? "").toEqual("");
      expect(cleared.snapshot.createdAt).toEqual(snapshot.createdAt);

      // Only this snapshot goes when it leaves the stack.
      yield* stack.deploy(Stackit.FileStorage.ResourcePool("SnapshotPool", base));
      yield* snapshotNames(projectId, region, resourcePoolId).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (remaining) => !remaining.includes(name),
          times: 12,
        }),
        Effect.map((remaining) => expect(remaining).not.toContain(name)),
      );

      yield* stack.destroy();
      yield* expectGone(observePool(projectId, region, resourcePoolId));
    }).pipe(logLevel),
  options,
);
