import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as modelExperiments from "@distilled.cloud/stackit/model_experiments";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, INSTANCE_TEST_TIMEOUT, observeInstance, slow } from "./modelExperiments.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("modelexperiments", "instance"),
  timeout: INSTANCE_TEST_TIMEOUT,
} as const;

const app = (props: Stackit.ModelExperiments.InstanceProps) =>
  Effect.gen(function* () {
    const instance = yield* Stackit.ModelExperiments.Instance("AppExperiments", props);
    return { instance };
  });

test.provider.skipIf(slow)(
  "create, update and delete an instance",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const props = {
        description: "alchemy test instance",
        deletedExperimentRetention: "30d",
        labels: { env: "test" },
      } satisfies Stackit.ModelExperiments.InstanceProps;
      const { instance } = yield* stack.deploy(app(props));
      expect(instance.instanceId).toEqual(expect.any(String));
      expect(instance.state).toEqual("active");
      expect(instance.url).toMatch(/^https:\/\//);
      expect(instance.labels).toEqual({ env: "test" });

      // Out of band: the instance exists, with our labels and its settings.
      const { instance: fetched } = yield* modelExperiments.getInstance({
        projectId,
        regionId: region,
        instanceId: instance.instanceId,
      });
      expect(fetched.state).toEqual("active");
      expect(fetched.description).toEqual("alchemy test instance");
      expect(fetched.labels).toMatchObject({ env: "test", "alchemy.id": "AppExperiments" });

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(app(props));
      expect(plan.resources.AppExperiments).toMatchObject({ action: "noop" });

      // Name, description, retention and labels update in place, and a removed label goes.
      const { instance: updated } = yield* stack.deploy(
        app({
          name: "alchemy-experiments-updated",
          description: "alchemy test instance updated",
          deletedExperimentRetention: "7d",
          labels: { stage: "prod" },
        }),
      );
      expect(updated.instanceId).toEqual(instance.instanceId);
      expect(updated.url).toEqual(instance.url);
      expect(updated.name).toEqual("alchemy-experiments-updated");
      const { instance: refetched } = yield* modelExperiments.getInstance({
        projectId,
        regionId: region,
        instanceId: instance.instanceId,
      });
      expect(refetched.name).toEqual("alchemy-experiments-updated");
      expect(refetched.description).toEqual("alchemy test instance updated");
      expect(refetched.labels).toMatchObject({ stage: "prod", "alchemy.id": "AppExperiments" });
      expect(refetched.labels?.env).toBeUndefined();

      yield* stack.destroy();
      yield* expectGone(observeInstance(projectId, region, instance.instanceId));
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "a foreign instance with the explicit name is unowned",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();
      const name = "alchemy-experiments-foreign";
      const { instance: foreign } = yield* modelExperiments.createInstance({
        projectId,
        regionId: region,
        name,
      });

      const error = yield* stack.deploy(app({ name })).pipe(Effect.flip);
      expect(error._tag).toEqual("OwnedBySomeoneElse");

      // Refusing it left it alone.
      const still = yield* observeInstance(projectId, region, foreign.id);
      expect(still).not.toEqual("gone");

      yield* modelExperiments.deleteInstance({
        projectId,
        regionId: region,
        instanceId: foreign.id,
      });
      yield* expectGone(observeInstance(projectId, region, foreign.id));
      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);
