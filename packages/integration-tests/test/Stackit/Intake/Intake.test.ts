import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as intake from "@distilled.cloud/stackit/intake";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { CAPACITY, CATALOG, expectGone, observeIntake, observeRunner, slow } from "./intake.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("intake", "intake"), timeout: 2_700_000 } as const;

const app = (
  props: Omit<Stackit.Intake.IntakeProps, "runnerId" | "catalog"> & {
    readonly catalog?: Partial<Stackit.Intake.IntakeCatalogConfig>;
    readonly onSecondRunner?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const { onSecondRunner, catalog, ...rest } = props;
    const first = yield* Stackit.Intake.Runner("IntakeRunner", CAPACITY);
    const second = onSecondRunner
      ? yield* Stackit.Intake.Runner("IntakeRunnerTwo", CAPACITY)
      : undefined;
    const pipeline = yield* Stackit.Intake.Intake("IntakeUnderTest", {
      runnerId: second?.runnerId ?? first.runnerId,
      catalog: { ...CATALOG, ...catalog },
      ...rest,
    });
    return { first, second, pipeline };
  });

test.provider.skipIf(slow)(
  "create, update, move and delete an intake",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const props = { description: "alchemy test intake", labels: { env: "test" } };
      const created = yield* stack.deploy(app(props));
      const pipeline = created.pipeline;
      expect(pipeline.state).toEqual("active");
      expect(pipeline.runnerId).toEqual(created.first.runnerId);
      expect(pipeline.topic.length).toBeGreaterThan(0);
      expect(pipeline.deadLetterTopic.length).toBeGreaterThan(0);
      expect(pipeline.uri).toMatch(/:\d+$/);

      // Out of band.
      const fetched = yield* intake.getIntake({
        projectId,
        regionId: region,
        intakeId: pipeline.intakeId,
      });
      expect(fetched.catalog.uri).toEqual(CATALOG.uri);
      expect(fetched.labels).toMatchObject({ env: "test", "alchemy.id": "IntakeUnderTest" });

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(app(props));
      expect(plan.resources.IntakeUnderTest).toMatchObject({ action: "noop" });

      // Everything else updates in place, including the runner.
      const updated = yield* stack.deploy(
        app({
          displayName: "alchemy-test-intake",
          description: "alchemy test intake updated",
          labels: { env: "prod" },
          catalog: { namespace: "alchemy_test", tableName: "events" },
          onSecondRunner: true,
        }),
      );
      expect(updated.pipeline.intakeId).toEqual(pipeline.intakeId);
      expect(updated.pipeline.runnerId).toEqual(updated.second!.runnerId);

      const afterUpdate = yield* intake.getIntake({
        projectId,
        regionId: region,
        intakeId: pipeline.intakeId,
      });
      expect(afterUpdate.displayName).toEqual("alchemy-test-intake");
      expect(afterUpdate.intakeRunnerId).toEqual(updated.second!.runnerId);
      expect(afterUpdate.catalog.namespace).toEqual("alchemy_test");
      expect(afterUpdate.catalog.tableName).toEqual("events");
      expect(afterUpdate.labels?.env).toEqual("prod");

      yield* stack.destroy();
      yield* expectGone(observeIntake(projectId, region, pipeline.intakeId));
      yield* expectGone(observeRunner(projectId, region, created.first.runnerId));
      yield* expectGone(observeRunner(projectId, region, updated.second!.runnerId));
    }).pipe(logLevel),
  options,
);
