import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as valkey from "@distilled.cloud/stackit/valkey";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import {
  CLOSED_ACL,
  expectGone,
  instanceProps,
  observeInstance,
  PLAN,
  slow,
  VERSION,
} from "./valkey.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("valkey", "instance"),
  timeout: 2_700_000,
} as const;

const UPDATED_ACL = "192.0.2.2/32";

/** The parameters the API reports, under either spelling of a key. */
const parameter = (instance: { readonly parameters: unknown }, key: string): unknown => {
  const parameters = instance.parameters as Record<string, unknown>;
  return parameters[key] ?? parameters[key.replaceAll("_", "-")];
};

test.provider.skipIf(slow)(
  "create, update, list and delete an instance",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region: regionId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const props = { ...instanceProps(), enableMonitoring: false };
      const created = yield* stack.deploy(Stackit.Valkey.Instance("BasicInstance", props));

      expect(created.instanceId).toEqual(expect.any(String));
      expect(created.projectId).toEqual(projectId);
      expect(created.region).toEqual(regionId);
      expect(created.status).toEqual("active");
      expect(created.planName.toLowerCase()).toEqual(PLAN.toLowerCase());
      expect(created.acl).toEqual([CLOSED_ACL]);

      // Out of band: the plan and parameters landed.
      const fetched = yield* valkey.getInstance({
        projectId,
        regionId,
        instanceId: created.instanceId,
      });
      expect(fetched.name).toEqual(created.name);
      expect(parameter(fetched, "sgw_acl")).toEqual(CLOSED_ACL);

      // `list` enumerates it, by its generated name.
      const provider = yield* Provider.findProvider(Stackit.Valkey.Instance);
      const listed = yield* provider.list();
      expect(listed.find((instance) => instance.instanceId === created.instanceId)?.name).toEqual(
        created.name,
      );

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(Stackit.Valkey.Instance("BasicInstance", props));
      expect(plan.resources.BasicInstance).toMatchObject({ action: "noop" });

      // Update in place. Leaving `automaticUpdates` set proves the sync against the
      // observed setting. Version and plan stay: a run has no higher plan to move to.
      const updated = yield* stack.deploy(
        Stackit.Valkey.Instance("BasicInstance", {
          ...instanceProps(UPDATED_ACL),
          enableMonitoring: false,
          automaticUpdates: true,
          maxmemoryPolicy: "allkeys-lru",
          downAfterMilliseconds: 20000,
        }),
      );
      expect(updated.instanceId).toEqual(created.instanceId);
      expect(updated.acl).toEqual([UPDATED_ACL]);
      expect(updated.automaticUpdates).toEqual(true);

      const refetched = yield* valkey.getInstance({
        projectId,
        regionId,
        instanceId: created.instanceId,
      });
      expect(parameter(refetched, "sgw_acl")).toEqual(UPDATED_ACL);
      // Keys with hyphens on the wire reach the instance under their own spelling.
      expect(parameter(refetched, "maxmemory_policy")).toEqual("allkeys-lru");
      expect(Number(parameter(refetched, "down_after_milliseconds"))).toEqual(20000);
      const updates = yield* valkey.getUpdates({
        projectId,
        regionId,
        instanceId: created.instanceId,
      });
      expect(updates.automaticUpdatesEnabled).toEqual(true);

      yield* stack.destroy();
      yield* expectGone(observeInstance(projectId, regionId, created.instanceId));
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "a new name replaces the instance and deletes the old one",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region: regionId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Stackit.Valkey.Instance("RenamedInstance", {
          ...instanceProps(),
          name: "alchemy-test-valkey-first",
        }),
      );
      expect(first.name).toEqual("alchemy-test-valkey-first");

      const second = yield* stack.deploy(
        Stackit.Valkey.Instance("RenamedInstance", {
          ...instanceProps(),
          name: "alchemy-test-valkey-second",
        }),
      );
      expect(second.instanceId).not.toEqual(first.instanceId);
      expect(second.name).toEqual("alchemy-test-valkey-second");
      yield* expectGone(observeInstance(projectId, regionId, first.instanceId));

      yield* stack.destroy();
      yield* expectGone(observeInstance(projectId, regionId, second.instanceId));
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "an explicit name with no state is refused without --adopt",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region: regionId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const name = "alchemy-test-valkey-foreign";
      const { offerings } = yield* valkey.listOfferings({ projectId, regionId });
      const plans = offerings.flatMap((offering) =>
        offering.version === VERSION ? offering.plans : [],
      );
      const planId = plans.find((plan) => plan.name === PLAN)?.id;
      expect(planId).toEqual(expect.any(String));
      const foreign = yield* valkey.createInstance({
        projectId,
        regionId,
        instanceName: name,
        planId: planId!,
      });

      const error = yield* stack
        .deploy(Stackit.Valkey.Instance("ForeignInstance", { ...instanceProps(), name }))
        .pipe(Effect.flip);
      expect(error._tag).toEqual("OwnedBySomeoneElse");

      // The foreign instance was neither taken over nor removed.
      const active = yield* valkey
        .getInstance({ projectId, regionId, instanceId: foreign.instanceId })
        .pipe(
          Effect.repeat({
            schedule: Schedule.spaced("15 seconds"),
            until: (instance) => instance.status !== "creating",
            times: 120,
          }),
        );
      expect(active.name).toEqual(name);

      yield* valkey.deleteInstance({ projectId, regionId, instanceId: foreign.instanceId });
      yield* expectGone(observeInstance(projectId, regionId, foreign.instanceId));
      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);
