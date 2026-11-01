import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as opensearch from "@distilled.cloud/stackit/opensearch";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { CLOSED_ACL, expectGone, observeInstance, PLAN, slow, VERSION } from "./opensearch.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("opensearch", "instance"),
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

      const created = yield* stack.deploy(Stackit.OpenSearch.Instance("BasicInstance", props));
      expect(created.instanceId).toEqual(expect.any(String));
      expect(created.projectId).toEqual(projectId);
      expect(created.region).toEqual(region);
      expect(created.status).toEqual("active");
      expect(created.version).toEqual(VERSION);
      expect(created.planName).toEqual(PLAN);
      expect(created.acl).toEqual([CLOSED_ACL]);

      // Out of band: the instance exists, with the generated name and the ACL.
      const fetched = yield* opensearch.getInstance({
        projectId,
        regionId: region,
        instanceId: created.instanceId,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.status).toEqual("active");
      expect(fetched.planName).toEqual(PLAN);

      // `list` finds it by its generated name.
      const provider = yield* Provider.findProvider(Stackit.OpenSearch.Instance);
      const listed = yield* provider.list();
      expect(listed.find((instance) => instance.instanceId === created.instanceId)?.name).toEqual(
        created.name,
      );

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(Stackit.OpenSearch.Instance("BasicInstance", props));
      expect(plan.resources.BasicInstance).toMatchObject({ action: "noop" });

      // Update the parameters and the update setting in place.
      const updated = yield* stack.deploy(
        Stackit.OpenSearch.Instance("BasicInstance", {
          ...props,
          acl: [UPDATED_ACL],
          automaticUpdates: true,
          metricsFrequency: 30,
          javaMaxmetaspace: 512,
        }),
      );
      expect(updated.instanceId).toEqual(created.instanceId);
      expect(updated.acl).toEqual([UPDATED_ACL]);
      expect(updated.automaticUpdates).toEqual(true);

      const refetched = yield* opensearch.getInstance({
        projectId,
        regionId: region,
        instanceId: created.instanceId,
      });
      expect(refetched.parameters).toMatchObject({
        sgw_acl: UPDATED_ACL,
        metrics_frequency: 30,
        java_maxmetaspace: 512,
      });
      const updates = yield* opensearch.getUpdates({
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
        Stackit.OpenSearch.Instance("RenamedInstance", {
          ...props,
          name: "alchemy-opensearch-rename-a",
        }),
      );
      expect(created.name).toEqual("alchemy-opensearch-rename-a");

      const renamed = yield* stack.deploy(
        Stackit.OpenSearch.Instance("RenamedInstance", {
          ...props,
          name: "alchemy-opensearch-rename-b",
        }),
      );
      expect(renamed.name).toEqual("alchemy-opensearch-rename-b");
      expect(renamed.instanceId).not.toEqual(created.instanceId);

      yield* expectGone(observeInstance(projectId, region, created.instanceId));

      yield* stack.destroy();

      yield* expectGone(observeInstance(projectId, region, renamed.instanceId));
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "an instance with an explicit name and no state is refused without --adopt",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const name = "alchemy-opensearch-foreign";
      const { offerings } = yield* opensearch.listOfferings({ projectId, regionId: region });
      const planId = offerings
        .find((offering) => offering.version === VERSION)
        ?.plans.find((plan) => plan.name === PLAN)?.id;
      expect(planId).toEqual(expect.any(String));
      const foreign = yield* opensearch.createInstance({
        projectId,
        regionId: region,
        instanceName: name,
        planId: planId!,
        parameters: { sgw_acl: CLOSED_ACL },
      });

      const error = yield* stack
        .deploy(Stackit.OpenSearch.Instance("ForeignInstance", { ...props, name }))
        .pipe(Effect.flip);
      expect(error._tag).toEqual("OwnedBySomeoneElse");

      // The foreign instance was neither taken over nor removed.
      const observed = yield* observeInstance(projectId, region, foreign.instanceId);
      expect(observed).not.toEqual("gone");

      yield* opensearch.deleteInstance({
        projectId,
        regionId: region,
        instanceId: foreign.instanceId,
      });
      yield* expectGone(observeInstance(projectId, region, foreign.instanceId));
      yield* stack.destroy();
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
          Stackit.OpenSearch.Instance("UnknownPlanInstance", {
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
  { tags: stackitTags("opensearch", "instance"), timeout: 180_000 },
);
