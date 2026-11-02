import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as sqlserver from "@distilled.cloud/stackit/sqlserverflex";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import {
  CLOSED_ACL,
  expectGone,
  gated,
  instanceProps,
  observeInstance,
  OTHER_STORAGE_CLASS,
} from "./sqlserver.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("sqlserverflex", "instance"),
  timeout: 5_400_000,
} as const;

const UPDATED_ACL = "192.0.2.2/32";

// One test on purpose: every instance costs at least an hour's licence, so the
// lifecycle and the replacement share the first one.
test.provider.skipIf(gated)(
  "create, update, protect, list, replace and delete an instance",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const props = { ...instanceProps(), labels: { env: "test", keep: "yes" } };
      const created = yield* stack.deploy(Stackit.SQLServerFlex.Instance("BasicInstance", props));

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

      // Out of band: the settings landed, with Alchemy's ownership labels.
      const fetched = yield* sqlserver.getInstance({
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
      const provider = yield* Provider.findProvider(Stackit.SQLServerFlex.Instance);
      const listed = yield* provider.list();
      expect(listed.find((instance) => instance.instanceId === created.instanceId)?.name).toEqual(
        created.name,
      );

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(Stackit.SQLServerFlex.Instance("BasicInstance", props));
      expect(plan.resources.BasicInstance).toMatchObject({ action: "noop" });

      // Update the mutable aspects in place. Flavor and version stay: the spec lists
      // one version, and a flavor change restarts the instance.
      const updatedProps = {
        ...instanceProps(UPDATED_ACL),
        storage: { ...props.storage, size: 10 },
        backupSchedule: "30 3 * * *",
        retentionDays: 40,
        labels: { env: "prod", role: "db" },
      };
      const updated = yield* stack.deploy(
        Stackit.SQLServerFlex.Instance("BasicInstance", updatedProps),
      );
      expect(updated.instanceId).toEqual(created.instanceId);
      expect(updated.storageSize).toEqual(10);
      expect(updated.retentionDays).toEqual(40);
      expect(updated.acl).toEqual([UPDATED_ACL]);

      const refetched = yield* sqlserver.getInstance({
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

      // Protection blocks a delete, until it is turned off. The spec names no status
      // for the refusal, so this asserts the outcome: the call fails and the instance
      // stays.
      const protectedInstance = yield* stack.deploy(
        Stackit.SQLServerFlex.Instance("BasicInstance", {
          ...updatedProps,
          deletionProtection: true,
        }),
      );
      expect(protectedInstance.isDeletable).toEqual(false);
      const rejected = yield* sqlserver
        .deleteInstance({ projectId, region, instanceId: created.instanceId })
        .pipe(Effect.result);
      expect(Result.isFailure(rejected)).toEqual(true);
      const kept = yield* observeInstance(projectId, region, created.instanceId);
      expect(kept === "gone" ? "gone" : kept.state).toEqual("READY");

      const unprotected = yield* stack.deploy(
        Stackit.SQLServerFlex.Instance("BasicInstance", {
          ...updatedProps,
          deletionProtection: false,
        }),
      );
      expect(unprotected.isDeletable).toEqual(true);

      // Changing the storage class replaces the instance.
      const moved = {
        ...updatedProps,
        storage: { class: OTHER_STORAGE_CLASS, size: 10 },
      };
      const replacePlan = yield* stack.plan(Stackit.SQLServerFlex.Instance("BasicInstance", moved));
      expect(replacePlan.resources.BasicInstance).toMatchObject({ action: "replace" });

      const replaced = yield* stack.deploy(Stackit.SQLServerFlex.Instance("BasicInstance", moved));
      expect(replaced.instanceId).not.toEqual(created.instanceId);
      expect(replaced.storageClass).toEqual(OTHER_STORAGE_CLASS);
      // A generated name carries the generation, so the two never collide.
      expect(replaced.name).not.toEqual(created.name);

      const fetchedReplacement = yield* sqlserver.getInstance({
        projectId,
        region,
        instanceId: replaced.instanceId,
      });
      expect(fetchedReplacement.storage.class).toEqual(OTHER_STORAGE_CLASS);

      // The old generation was deleted by the replacement.
      yield* expectGone(observeInstance(projectId, region, created.instanceId));

      yield* stack.destroy();

      yield* expectGone(observeInstance(projectId, region, replaced.instanceId));
    }).pipe(logLevel),
  options,
);
