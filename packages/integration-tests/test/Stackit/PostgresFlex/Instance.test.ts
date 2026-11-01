import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as postgres from "@distilled.cloud/stackit/postgres_flex";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import {
  CLOSED_ACL,
  expectGone,
  instanceProps,
  observeInstance,
  OTHER_STORAGE_CLASS,
  slow,
} from "./postgres.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("postgresflex", "instance"),
  timeout: 2_700_000,
} as const;

const UPDATED_ACL = "192.0.2.2/32";

/** An instance of the profile's project to clone, and a time it has a backup for. */
const cloneSource = process.env.STACKIT_TEST_POSTGRES_CLONE_SOURCE;
const clonePointInTime = process.env.STACKIT_TEST_POSTGRES_CLONE_POINT_IN_TIME;

test.provider.skipIf(slow)(
  "create, update, protect, list and delete an instance",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const props = { ...instanceProps(), labels: { env: "test", keep: "yes" } };
      const created = yield* stack.deploy(Stackit.PostgresFlex.Instance("BasicInstance", props));

      expect(created.instanceId).toEqual(expect.any(String));
      expect(created.projectId).toEqual(projectId);
      expect(created.region).toEqual(region);
      expect(created.state).toEqual("READY");
      expect(created.flavorId).toEqual(props.flavorId);
      expect(created.version).toEqual(props.version);
      expect(created.storageClass).toEqual(props.storage.class);
      expect(created.storageSize).toEqual(5);
      expect(created.retentionDays).toEqual(32);
      expect(created.acl).toEqual([CLOSED_ACL]);
      expect(created.accessScope).toEqual("PUBLIC");
      expect(created.isDeletable).toEqual(true);
      expect(created.labels).toEqual({ env: "test", keep: "yes" });
      expect(created.host.length).toBeGreaterThan(0);
      expect(created.port).toBeGreaterThan(0);

      // Out of band: the settings landed, with Alchemy's ownership labels.
      const fetched = yield* postgres.getInstance({
        projectId,
        region,
        instanceId: created.instanceId,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.network.acl).toEqual([CLOSED_ACL]);
      expect(fetched.labels).toMatchObject({
        env: "test",
        keep: "yes",
        "alchemy.id": "BasicInstance",
      });

      // `list` enumerates it, by its ownership labels.
      const provider = yield* Provider.findProvider(Stackit.PostgresFlex.Instance);
      const listed = yield* provider.list();
      expect(listed.find((instance) => instance.instanceId === created.instanceId)?.name).toEqual(
        created.name,
      );

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(Stackit.PostgresFlex.Instance("BasicInstance", props));
      expect(plan.resources.BasicInstance).toMatchObject({ action: "noop" });

      // Update the mutable aspects in place. Flavor and version stay: changing them
      // restarts the instance, and needs a higher version or flavor per run.
      const updatedProps = {
        ...instanceProps(UPDATED_ACL),
        storage: { ...props.storage, size: 10 },
        backupSchedule: "30 3 * * *",
        retentionDays: 40,
        labels: { env: "prod", role: "db" },
      };
      const updated = yield* stack.deploy(
        Stackit.PostgresFlex.Instance("BasicInstance", updatedProps),
      );
      expect(updated.instanceId).toEqual(created.instanceId);
      expect(updated.storageSize).toEqual(10);
      expect(updated.retentionDays).toEqual(40);
      expect(updated.acl).toEqual([UPDATED_ACL]);

      const refetched = yield* postgres.getInstance({
        projectId,
        region,
        instanceId: created.instanceId,
      });
      expect(refetched.storage.size).toEqual(10);
      expect(refetched.backupSchedule).toEqual("30 3 * * *");
      expect(refetched.retentionDays).toEqual(40);
      expect(refetched.network.acl).toEqual([UPDATED_ACL]);
      // The removed `keep` label is gone; ownership labels survive.
      expect(refetched.labels).toMatchObject({
        env: "prod",
        role: "db",
        "alchemy.id": "BasicInstance",
      });
      expect(refetched.labels?.keep).toBeUndefined();

      // Protection blocks a delete with the typed error, until it is turned off.
      const protectedInstance = yield* stack.deploy(
        Stackit.PostgresFlex.Instance("BasicInstance", {
          ...updatedProps,
          deletionProtection: true,
        }),
      );
      expect(protectedInstance.isDeletable).toEqual(false);
      const rejected = yield* postgres
        .deleteInstance({ projectId, region, instanceId: created.instanceId })
        .pipe(Effect.flip);
      expect(rejected._tag).toEqual("PreconditionFailed");

      const unprotected = yield* stack.deploy(
        Stackit.PostgresFlex.Instance("BasicInstance", {
          ...updatedProps,
          deletionProtection: false,
        }),
      );
      expect(unprotected.isDeletable).toEqual(true);

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
        Stackit.PostgresFlex.Instance("ReplaceInstance", instanceProps()),
      );

      const moved = {
        ...instanceProps(),
        storage: { class: OTHER_STORAGE_CLASS, size: 5 },
      };
      const plan = yield* stack.plan(Stackit.PostgresFlex.Instance("ReplaceInstance", moved));
      expect(plan.resources.ReplaceInstance).toMatchObject({ action: "replace" });

      const replaced = yield* stack.deploy(Stackit.PostgresFlex.Instance("ReplaceInstance", moved));
      expect(replaced.instanceId).not.toEqual(created.instanceId);
      expect(replaced.storageClass).toEqual(OTHER_STORAGE_CLASS);
      // A generated name carries the generation, so the two never collide.
      expect(replaced.name).not.toEqual(created.name);

      const fetched = yield* postgres.getInstance({
        projectId,
        region,
        instanceId: replaced.instanceId,
      });
      expect(fetched.storage.class).toEqual(OTHER_STORAGE_CLASS);

      // The old generation was deleted by the replacement.
      yield* expectGone(observeInstance(projectId, region, created.instanceId));

      yield* stack.destroy();

      yield* expectGone(observeInstance(projectId, region, replaced.instanceId));
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow || !cloneSource || !clonePointInTime)(
  "a clone interrupted before its labels are written is still picked up",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const clone = Stackit.PostgresFlex.Instance("InterruptedClone", {
        ...instanceProps(),
        cloneFrom: { instanceId: cloneSource!, pointInTime: clonePointInTime! },
      });

      // Long enough for the clone call, far too short for the clone to be ready, so
      // the PATCH that writes its labels never ran.
      const interrupted = yield* stack.deploy(clone).pipe(Effect.timeoutOption("90 seconds"));
      expect(Option.isNone(interrupted)).toBe(true);

      const finished = yield* stack.deploy(clone);
      expect(finished.state).toEqual("READY");

      // Out of band: the same clone, with Alchemy's labels now.
      const fetched = yield* postgres.getInstance({
        projectId,
        region,
        instanceId: finished.instanceId,
      });
      expect(fetched.labels).toMatchObject({ "alchemy.id": "InterruptedClone" });

      yield* stack.destroy();

      yield* expectGone(observeInstance(projectId, region, finished.instanceId));
    }).pipe(logLevel),
  options,
);
