import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as mongodb from "@distilled.cloud/stackit/mongodb_flex";
import * as Provider from "alchemy/Provider";
import { type CreatingResourceState, State } from "alchemy/State";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import {
  CLOSED_ACL,
  expectGone,
  FLAVOR,
  instanceProps,
  observeInstance,
  slow,
  STORAGE_CLASS,
} from "./mongodb.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("mongodbflex", "instance"),
  timeout: 2_700_000,
} as const;

const UPDATED_ACL = "192.0.2.2/32";

test.provider.skipIf(slow)(
  "create, update, list and delete an instance",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const props = {
        ...instanceProps(),
        snapshotRetentionDays: 4,
        dailySnapshotRetentionDays: 3,
        pointInTimeWindowHours: 30,
      };
      const created = yield* stack.deploy(Stackit.MongoDBFlex.Instance("BasicInstance", props));

      expect(created.instanceId).toEqual(expect.any(String));
      expect(created.projectId).toEqual(projectId);
      expect(created.region).toEqual(region);
      expect(created.status).toEqual("READY");
      expect(created.flavorId).toEqual(FLAVOR);
      expect(created.version).toEqual(props.version);
      expect(created.replicas).toEqual(props.replicas);
      expect(created.type).toEqual("Replica");
      expect(created.storageClass).toEqual(STORAGE_CLASS);
      expect(created.storageSize).toEqual(10);
      expect(created.acl).toEqual([CLOSED_ACL]);
      expect(created.snapshotRetentionDays).toEqual(4);
      expect(created.dailySnapshotRetentionDays).toEqual(3);
      expect(created.pointInTimeWindowHours).toEqual(30);

      // Out of band: the settings landed.
      const { item: fetched } = yield* mongodb.getInstance({
        projectId,
        region,
        instanceId: created.instanceId,
      });
      expect(fetched?.name).toEqual(created.name);
      expect(fetched?.acl?.items).toEqual([CLOSED_ACL]);
      expect(fetched?.options?.type).toEqual("Replica");
      expect(fetched?.options?.snapshotRetentionDays).toEqual("4");

      // `list` enumerates it, by the shape of its generated name.
      const provider = yield* Provider.findProvider(Stackit.MongoDBFlex.Instance);
      const listed = yield* provider.list();
      expect(listed.find((instance) => instance.instanceId === created.instanceId)?.name).toEqual(
        created.name,
      );

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(Stackit.MongoDBFlex.Instance("BasicInstance", props));
      expect(plan.resources.BasicInstance).toMatchObject({ action: "noop" });

      // Update the mutable aspects in place. Flavor and version stay: changing them
      // restarts the nodes, and needs a higher version or flavor per run.
      const updated = yield* stack.deploy(
        Stackit.MongoDBFlex.Instance("BasicInstance", {
          ...instanceProps(UPDATED_ACL),
          storage: { ...props.storage, size: 20 },
          // Leading zeros are the same schedule: the API answers without them.
          backupSchedule: "00 03 * * *",
          snapshotRetentionDays: 3,
          dailySnapshotRetentionDays: 3,
          pointInTimeWindowHours: 30,
        }),
      );
      expect(updated.instanceId).toEqual(created.instanceId);
      expect(updated.storageSize).toEqual(20);
      expect(updated.acl).toEqual([UPDATED_ACL]);
      expect(updated.snapshotRetentionDays).toEqual(3);

      const { item: refetched } = yield* mongodb.getInstance({
        projectId,
        region,
        instanceId: created.instanceId,
      });
      expect(refetched?.storage?.size).toEqual(20);
      expect(refetched?.backupSchedule).toEqual("0 3 * * *");
      expect(refetched?.acl?.items).toEqual([UPDATED_ACL]);
      expect(refetched?.options?.snapshotRetentionDays).toEqual("3");

      yield* stack.destroy();

      yield* expectGone(observeInstance(projectId, region, created.instanceId));
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "changing the storage class replaces the instance",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stackit.MongoDBFlex.Instance("ReplaceInstance", instanceProps()),
      );

      // Another class this flavor offers, from the API: no list of them is published.
      const { storageClasses } = yield* mongodb.listStorages({
        projectId,
        region,
        flavor: FLAVOR,
      });
      const otherClass = (storageClasses ?? []).find((name) => name !== STORAGE_CLASS);
      expect(otherClass).toEqual(expect.any(String));

      const moved = { ...instanceProps(), storage: { class: otherClass!, size: 10 } };
      const plan = yield* stack.plan(Stackit.MongoDBFlex.Instance("ReplaceInstance", moved));
      expect(plan.resources.ReplaceInstance).toMatchObject({ action: "replace" });

      const replaced = yield* stack.deploy(Stackit.MongoDBFlex.Instance("ReplaceInstance", moved));
      expect(replaced.instanceId).not.toEqual(created.instanceId);
      expect(replaced.storageClass).toEqual(otherClass);
      // A generated name carries the generation, so the two never collide.
      expect(replaced.name).not.toEqual(created.name);

      const { item: fetched } = yield* mongodb.getInstance({
        projectId,
        region,
        instanceId: replaced.instanceId,
      });
      expect(fetched?.storage?.class).toEqual(otherClass);

      // The old generation was deleted by the replacement.
      yield* expectGone(observeInstance(projectId, region, created.instanceId));

      yield* stack.destroy();

      yield* expectGone(observeInstance(projectId, region, replaced.instanceId));
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "an instance a crash left without state is picked up by its generated name",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stackit.MongoDBFlex.Instance("CrashedInstance", instanceProps()),
      );

      // What a crash after `createInstance` leaves: a row still creating, with its
      // instance id, and no attributes.
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        const key = { stack: stack.name, stage: stack.stage, fqn: "CrashedInstance" };
        const row = yield* state.get(key);
        if (row?.status !== "created") {
          return yield* Effect.fail(new Error("Expected a created row"));
        }
        const { attr: _attr, ...rest } = row;
        yield* state.set({
          ...key,
          value: { ...rest, status: "creating" } satisfies CreatingResourceState,
        });
      }).pipe(Effect.provide(stack.state));

      const recovered = yield* stack.deploy(
        Stackit.MongoDBFlex.Instance("CrashedInstance", instanceProps()),
      );
      expect(recovered.instanceId).toEqual(created.instanceId);
      expect(recovered.name).toEqual(created.name);

      yield* stack.destroy();

      yield* expectGone(observeInstance(projectId, region, created.instanceId));
    }).pipe(logLevel),
  options,
);
