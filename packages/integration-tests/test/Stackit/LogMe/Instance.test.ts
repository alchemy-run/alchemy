import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as logme from "@distilled.cloud/stackit/logme";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { CLOSED_ACL, expectGone, observeInstance, PLAN, slow, VERSION } from "./logme.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("logme", "instance"),
  timeout: 2_700_000,
} as const;

const UPDATED_ACL = "192.0.2.2/32";

const props = { version: VERSION, planName: PLAN, acl: [CLOSED_ACL] };

test.provider.skipIf(slow)(
  "create, update, list and delete an instance",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(Stackit.LogMe.Instance("BasicInstance", props));
      expect(created.instanceId).toEqual(expect.any(String));
      expect(created.projectId).toEqual(projectId);
      expect(created.region).toEqual(region);
      expect(created.status).toEqual("active");
      expect(created.version).toEqual(VERSION);
      expect(created.planName).toEqual(PLAN);
      expect(created.acl).toEqual([CLOSED_ACL]);

      // Out of band: the instance exists, with the generated name and the ACL.
      const fetched = yield* logme.getInstance({
        projectId,
        regionId: region,
        instanceId: created.instanceId,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.status).toEqual("active");
      expect(fetched.planName).toEqual(PLAN);

      // `list` finds it by its generated name.
      const provider = yield* Provider.findProvider(Stackit.LogMe.Instance);
      const listed = yield* provider.list();
      expect(listed.find((instance) => instance.instanceId === created.instanceId)?.name).toEqual(
        created.name,
      );

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(Stackit.LogMe.Instance("BasicInstance", props));
      expect(plan.resources.BasicInstance).toMatchObject({ action: "noop" });

      // Update the parameters and the update setting in place.
      const updated = yield* stack.deploy(
        Stackit.LogMe.Instance("BasicInstance", {
          ...props,
          acl: [UPDATED_ACL],
          automaticUpdates: true,
          metricsFrequency: 30,
          ismDeletionAfter: "14d",
        }),
      );
      expect(updated.instanceId).toEqual(created.instanceId);
      expect(updated.acl).toEqual([UPDATED_ACL]);
      expect(updated.automaticUpdates).toEqual(true);

      const refetched = yield* logme.getInstance({
        projectId,
        regionId: region,
        instanceId: created.instanceId,
      });
      expect(refetched.parameters).toMatchObject({
        sgw_acl: UPDATED_ACL,
        metrics_frequency: 30,
        ism_deletion_after: "14d",
      });
      const updates = yield* logme.getUpdates({
        projectId,
        regionId: region,
        instanceId: created.instanceId,
      });
      expect(updates.automaticUpdatesEnabled).toEqual(true);

      yield* stack.destroy();

      yield* expectGone(observeInstance(projectId, region, created.instanceId));
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "a new name replaces the instance and deletes the old one",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stackit.LogMe.Instance("RenamedInstance", { ...props, name: "alchemy-logme-rename-a" }),
      );
      expect(created.name).toEqual("alchemy-logme-rename-a");

      const renamed = yield* stack.deploy(
        Stackit.LogMe.Instance("RenamedInstance", { ...props, name: "alchemy-logme-rename-b" }),
      );
      expect(renamed.name).toEqual("alchemy-logme-rename-b");
      expect(renamed.instanceId).not.toEqual(created.instanceId);

      yield* expectGone(observeInstance(projectId, region, created.instanceId));

      yield* stack.destroy();

      yield* expectGone(observeInstance(projectId, region, renamed.instanceId));
    }).pipe(logLevel),
  options,
);

// Fails before anything is created, so it costs nothing and needs no gate.
test.provider(
  "a plan that doesn't exist fails with the typed error, naming the choices",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* stack
        .deploy(
          Stackit.LogMe.Instance("UnknownPlanInstance", {
            version: VERSION,
            planName: "no-such-plan",
          }),
        )
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "Stackit.SearchService.PlanNotFound",
        planName: "no-such-plan",
      });

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: stackitTags("logme", "instance"), timeout: 180_000 },
);
