import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as intake from "@distilled.cloud/stackit/intake";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { CAPACITY, CATALOG, expectGone, observeIntake, observeRunner, slow } from "./intake.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("intake", "runner"), timeout: 2_700_000 } as const;

test.provider.skipIf(slow)(
  "create, raise, lower and delete a runner",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const props = { ...CAPACITY, description: "alchemy test runner", labels: { env: "test" } };
      const created = yield* stack.deploy(Stackit.Intake.Runner("BasicRunner", props));
      expect(created.state).toEqual("active");
      expect(created.uri).toMatch(/:\d+$/);
      expect(created.labels).toEqual({ env: "test" });

      // Out of band.
      const fetched = yield* intake.getIntakeRunner({
        projectId,
        regionId: region,
        intakeRunnerId: created.runnerId,
      });
      expect(fetched.maxMessagesPerHour).toEqual(CAPACITY.maxMessagesPerHour);
      expect(fetched.labels).toMatchObject({ env: "test", "alchemy.id": "BasicRunner" });

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(Stackit.Intake.Runner("BasicRunner", props));
      expect(plan.resources.BasicRunner).toMatchObject({ action: "noop" });

      // A larger product, and the name, update in place.
      const raised = yield* stack.deploy(
        Stackit.Intake.Runner("BasicRunner", {
          ...props,
          displayName: "alchemy-test-runner",
          maxMessagesPerHour: CAPACITY.maxMessagesPerHour * 2,
          labels: { env: "prod" },
        }),
      );
      expect(raised.runnerId).toEqual(created.runnerId);
      const afterRaise = yield* intake.getIntakeRunner({
        projectId,
        regionId: region,
        intakeRunnerId: created.runnerId,
      });
      expect(afterRaise.displayName).toEqual("alchemy-test-runner");
      expect(afterRaise.maxMessagesPerHour).toEqual(CAPACITY.maxMessagesPerHour * 2);
      expect(afterRaise.labels?.env).toEqual("prod");

      // A smaller product plans a replacement, and leaves no second runner behind.
      const lowered = yield* stack.deploy(Stackit.Intake.Runner("BasicRunner", CAPACITY));
      expect(lowered.runnerId).not.toEqual(created.runnerId);
      yield* expectGone(observeRunner(projectId, region, created.runnerId));

      yield* stack.destroy();
      yield* expectGone(observeRunner(projectId, region, lowered.runnerId));
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "an intake made out of band stops the destroy, before the runner is stuck deleting",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const { runnerId } = yield* stack.deploy(Stackit.Intake.Runner("GuardedRunner", CAPACITY));
      const foreign = yield* intake.createIntake({
        projectId,
        regionId: region,
        displayName: "alchemy-test-hand-made",
        intakeRunnerId: runnerId,
        catalog: CATALOG,
      });
      yield* intake.getIntake({ projectId, regionId: region, intakeId: foreign.id }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (live) => live.state !== "reconciling",
          times: 60,
        }),
      );

      const refused = yield* stack.destroy().pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "Stackit.Intake.RunnerNotEmpty",
        intakes: ["alchemy-test-hand-made"],
      });
      const live = yield* observeRunner(projectId, region, runnerId);
      expect(live).toMatchObject({ state: "active" });

      yield* intake.deleteIntake({ projectId, regionId: region, intakeId: foreign.id });
      yield* expectGone(observeIntake(projectId, region, foreign.id));
      yield* stack.destroy();
      yield* expectGone(observeRunner(projectId, region, runnerId));
    }).pipe(logLevel),
  options,
);
