import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import {
  CLOSED_ACL,
  cheapestPerformanceClass,
  expectGone,
  observePool,
  observeShare,
  poolProps,
  slow,
} from "./fileStorage.ts";

const { test } = makeStackitTest();

// One pool for at least a started hour (see `fileStorage.ts`).
const options = { tags: stackitTags("filestorage", "share"), timeout: 3_600_000 } as const;

const app = (
  base: Stackit.FileStorage.ResourcePoolProps,
  share: Omit<Stackit.FileStorage.ShareProps, "resourcePoolId">,
  policyName?: "a" | "b",
) =>
  Effect.gen(function* () {
    const pool = yield* Stackit.FileStorage.ResourcePool("SharePool", base);
    const first = yield* Stackit.FileStorage.ShareExportPolicy("SharePolicyA", {
      rules: [{ order: 1, ipAcl: [CLOSED_ACL] }],
    });
    const second = yield* Stackit.FileStorage.ShareExportPolicy("SharePolicyB", {
      rules: [{ order: 1, ipAcl: [CLOSED_ACL], readOnly: true }],
    });
    const exportPolicyName =
      policyName === "a" ? first.name : policyName === "b" ? second.name : undefined;
    return {
      pool,
      first,
      second,
      share: yield* Stackit.FileStorage.Share("ShareUnderTest", {
        resourcePoolId: pool.resourcePoolId,
        ...share,
        ...(exportPolicyName !== undefined ? { exportPolicyName } : {}),
      }),
    };
  });

test.provider.skipIf(slow)(
  "create, update, keep through a pool update, replace and delete a share",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const performanceClass = yield* cheapestPerformanceClass;
      const base = poolProps(region, performanceClass);
      yield* stack.destroy();

      const created = yield* stack.deploy(
        app(base, { spaceHardLimitGigabytes: 10, labels: { env: "test" } }),
      );
      const resourcePoolId = created.pool.resourcePoolId;
      const { share } = created;
      expect(share.shareId).toEqual(expect.any(String));
      expect(share.resourcePoolId).toEqual(resourcePoolId);
      expect(share.projectId).toEqual(projectId);
      expect(share.region).toEqual(region);
      expect(share.state).toEqual("created");
      expect(share.spaceHardLimitGigabytes).toEqual(10);
      expect(share.exportPolicy).toBeUndefined();
      expect(share.labels).toEqual({ env: "test" });
      // `host:/rp_x/share`, as STACKIT documents it.
      expect(share.mountPath).toMatch(/^[^:]+:\/.+/);

      // Out of band: the share and Alchemy's ownership labels.
      const fetched = yield* observeShare(projectId, region, resourcePoolId, share.shareId);
      expect(fetched).toMatchObject({
        name: share.name,
        state: "created",
        spaceHardLimitGigabytes: 10,
        labels: { env: "test", "alchemy.id": "ShareUnderTest" },
      });

      // `list` enumerates it.
      const provider = yield* Provider.findProvider(Stackit.FileStorage.Share);
      const listed = yield* provider.list();
      expect(listed.find((entry) => entry.shareId === share.shareId)?.name).toEqual(share.name);

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(
        app(base, { spaceHardLimitGigabytes: 10, labels: { env: "test" } }),
      );
      expect(plan.resources.ShareUnderTest).toMatchObject({ action: "noop" });

      // The limit, the labels and the policy update in place.
      const updated = yield* stack.deploy(
        app(base, { spaceHardLimitGigabytes: 20, labels: { env: "prod" } }, "a"),
      );
      expect(updated.share.shareId).toEqual(share.shareId);
      expect(updated.share.spaceHardLimitGigabytes).toEqual(20);
      expect(updated.share.exportPolicy).toEqual(updated.first.name);
      expect(updated.share.mountPath).toEqual(share.mountPath);
      const refetched = yield* observeShare(projectId, region, resourcePoolId, share.shareId);
      expect(refetched).toMatchObject({
        spaceHardLimitGigabytes: 20,
        exportPolicy: { name: updated.first.name },
        labels: { env: "prod" },
      });

      // Switching policies keeps the share.
      const switched = yield* stack.deploy(
        app(base, { spaceHardLimitGigabytes: 20, labels: { env: "prod" } }, "b"),
      );
      expect(switched.share.shareId).toEqual(share.shareId);
      expect(switched.share.exportPolicy).toEqual(switched.second.name);

      // Dropping the prop takes the policy off.
      const detached = yield* stack.deploy(
        app(base, { spaceHardLimitGigabytes: 20, labels: { env: "prod" } }),
      );
      expect(detached.share.exportPolicy).toBeUndefined();
      const noPolicy = yield* observeShare(projectId, region, resourcePoolId, share.shareId);
      expect(noPolicy).toMatchObject({ state: "created" });
      expect(noPolicy === "gone" ? undefined : noPolicy?.exportPolicy?.name).toBeUndefined();

      // A small edit of the pool must not replace, and so empty, the share in it.
      const widened = { ...base, ipAcl: [CLOSED_ACL, "198.51.100.0/24"] };
      const widenedPlan = yield* stack.plan(
        app(widened, { spaceHardLimitGigabytes: 20, labels: { env: "prod" } }),
      );
      expect(widenedPlan.resources.SharePool).toMatchObject({ action: "update" });
      expect(widenedPlan.resources.ShareUnderTest).toMatchObject({ action: "noop" });
      const afterPoolEdit = yield* stack.deploy(
        app(widened, { spaceHardLimitGigabytes: 20, labels: { env: "prod" } }),
      );
      expect(afterPoolEdit.pool.resourcePoolId).toEqual(resourcePoolId);
      expect(afterPoolEdit.share.shareId).toEqual(share.shareId);

      // A new name replaces the share and deletes the old one. The pool stays.
      const name = "alchemy-test-share-renamed";
      const replacePlan = yield* stack.plan(
        app(widened, { name, spaceHardLimitGigabytes: 20, labels: { env: "prod" } }),
      );
      expect(replacePlan.resources.ShareUnderTest).toMatchObject({ action: "replace" });
      const replaced = yield* stack.deploy(
        app(widened, { name, spaceHardLimitGigabytes: 20, labels: { env: "prod" } }),
      );
      expect(replaced.share.name).toEqual(name);
      expect(replaced.share.shareId).not.toEqual(share.shareId);
      yield* expectGone(observeShare(projectId, region, resourcePoolId, share.shareId));

      yield* stack.destroy();
      yield* expectGone(observePool(projectId, region, resourcePoolId));
    }).pipe(logLevel),
  options,
);
