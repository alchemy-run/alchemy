import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as sfs from "@distilled.cloud/stackit/sfs";
import * as Provider from "alchemy/Provider";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import {
  CLOSED_ACL,
  cheapestPerformanceClass,
  expectGone,
  MIN_SIZE,
  observePool,
  observeShare,
  poolProps,
  slow,
} from "./fileStorage.ts";

const { test } = makeStackitTest();

// Two pools for at least a started hour each (see `fileStorage.ts`). Pool operations can
// take the SDK's 30 minutes each.
const options = { tags: stackitTags("filestorage", "resourcepool"), timeout: 5_400_000 } as const;

const poolOf = (props: Stackit.FileStorage.ResourcePoolProps) =>
  Stackit.FileStorage.ResourcePool("PoolUnderTest", props);

test.provider.skipIf(slow)(
  "create, update, refuse a blocked shrink, replace, protect foreign shares and delete a pool",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const performanceClass = yield* cheapestPerformanceClass;
      const base = poolProps(region, performanceClass);
      yield* stack.destroy();

      const created = yield* stack.deploy(poolOf({ ...base, labels: { env: "test" } }));
      expect(created.resourcePoolId).toEqual(expect.any(String));
      expect(created.projectId).toEqual(projectId);
      expect(created.region).toEqual(region);
      expect(created.state).toEqual("created");
      expect(created.availabilityZone).toEqual(base.availabilityZone);
      expect(created.performanceClass.name).toEqual(performanceClass);
      expect(created.sizeGigabytes).toEqual(MIN_SIZE);
      expect(created.ipAcl).toEqual([CLOSED_ACL]);
      expect(created.labels).toEqual({ env: "test" });

      // Out of band: the pool and Alchemy's ownership labels.
      const fetched = yield* observePool(projectId, region, created.resourcePoolId);
      expect(fetched).toMatchObject({
        name: created.name,
        state: "created",
        labels: { env: "test", "alchemy.id": "PoolUnderTest" },
      });

      // `list` enumerates it.
      const provider = yield* Provider.findProvider(Stackit.FileStorage.ResourcePool);
      const listed = yield* provider.list();
      expect(listed.find((entry) => entry.resourcePoolId === created.resourcePoolId)?.name).toEqual(
        created.name,
      );

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(poolOf({ ...base, labels: { env: "test" } }));
      expect(plan.resources.PoolUnderTest).toMatchObject({ action: "noop" });

      // ACL, labels, snapshot visibility and size update in place, keeping the pool.
      const grown = yield* stack.deploy(
        poolOf({
          ...base,
          sizeGigabytes: MIN_SIZE + 1,
          ipAcl: [CLOSED_ACL, "198.51.100.0/24"],
          snapshotsAreVisible: true,
          labels: { env: "prod" },
        }),
      );
      expect(grown.resourcePoolId).toEqual(created.resourcePoolId);
      expect(grown.sizeGigabytes).toEqual(MIN_SIZE + 1);
      const refetched = yield* observePool(projectId, region, created.resourcePoolId);
      expect(refetched).toMatchObject({
        space: { sizeGigabytes: MIN_SIZE + 1 },
        snapshotsAreVisible: true,
        labels: { env: "prod" },
      });

      // Shrinking inside the cooldown fails typed, leaving the pool as it is. Past it, the
      // shrink goes through. The API decides which, through `sizeReducibleAt`.
      const now = yield* Clock.currentTimeMillis;
      const inCooldown =
        grown.sizeReducibleAt !== undefined && Date.parse(grown.sizeReducibleAt) > now;
      const shrink = yield* stack
        .deploy(
          poolOf({
            ...base,
            ipAcl: [CLOSED_ACL, "198.51.100.0/24"],
            snapshotsAreVisible: true,
            labels: { env: "prod" },
          }),
        )
        .pipe(Effect.result);
      expect(Result.isFailure(shrink)).toEqual(inCooldown);
      if (Result.isFailure(shrink)) {
        expect(shrink.failure._tag).toEqual("Stackit.FileStorage.ResourcePoolChangeBlocked");
      }
      const expectedSize = inCooldown ? MIN_SIZE + 1 : MIN_SIZE;
      const afterShrink = yield* observePool(projectId, region, created.resourcePoolId);
      expect(afterShrink).toMatchObject({ space: { sizeGigabytes: expectedSize } });

      // A new explicit name replaces the pool: a second billed pool, comes up first, and
      // the old one is deleted.
      const name = "alchemy-test-pool-renamed";
      const replacePlan = yield* stack.plan(poolOf({ ...base, name }));
      expect(replacePlan.resources.PoolUnderTest).toMatchObject({ action: "replace" });
      const replaced = yield* stack.deploy(poolOf({ ...base, name }));
      expect(replaced.name).toEqual(name);
      expect(replaced.resourcePoolId).not.toEqual(created.resourcePoolId);
      yield* expectGone(observePool(projectId, region, created.resourcePoolId));

      // A share this stack doesn't know: a destroy refuses to take its data with the pool.
      const foreign = yield* sfs.createShare({
        projectId,
        region,
        resourcePoolId: replaced.resourcePoolId,
        name: "alchemy-test-foreign-share",
        spaceHardLimitGigabytes: 0,
      });
      const foreignId = foreign.share?.id;
      expect(foreignId).toEqual(expect.any(String));
      yield* observeShare(projectId, region, replaced.resourcePoolId, foreignId!).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (share) => share !== "gone" && share?.state === "created",
          times: 60,
        }),
      );
      const refused = yield* stack.destroy().pipe(Effect.flip);
      expect(refused._tag).toEqual("Stackit.FileStorage.ResourcePoolNotEmpty");
      const survivor = yield* observeShare(projectId, region, replaced.resourcePoolId, foreignId!);
      expect(survivor).toMatchObject({ name: "alchemy-test-foreign-share" });

      yield* sfs.deleteShare({
        projectId,
        region,
        resourcePoolId: replaced.resourcePoolId,
        shareId: foreignId!,
      });
      yield* expectGone(observeShare(projectId, region, replaced.resourcePoolId, foreignId!));

      yield* stack.destroy();
      yield* expectGone(observePool(projectId, region, replaced.resourcePoolId));
    }).pipe(logLevel),
  options,
);
