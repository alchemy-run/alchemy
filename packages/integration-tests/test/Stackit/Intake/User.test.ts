import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as intake from "@distilled.cloud/stackit/intake";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import {
  CAPACITY,
  CATALOG,
  expectGone,
  observeIntake,
  observeRunner,
  observeUser,
  PASSWORD,
  slow,
} from "./intake.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("intake", "user"), timeout: 2_700_000 } as const;

const app = (user?: Omit<Stackit.Intake.UserProps, "intakeId">) =>
  Effect.gen(function* () {
    const runner = yield* Stackit.Intake.Runner("UserRunner", CAPACITY);
    const pipeline = yield* Stackit.Intake.Intake("UserIntake", {
      runnerId: runner.runnerId,
      catalog: CATALOG,
    });
    if (user === undefined) return { runner, pipeline, user: undefined };
    return {
      runner,
      pipeline,
      user: yield* Stackit.Intake.User("UserUnderTest", {
        intakeId: pipeline.intakeId,
        ...user,
      }),
    };
  });

test.provider.skipIf(slow)(
  "create, update, rotate and delete a user, and refuse a foreign one",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const props = {
        password: Redacted.make(PASSWORD),
        description: "alchemy test user",
        labels: { env: "test" },
      };
      const created = yield* stack.deploy(app(props));
      const user = created.user!;
      const intakeId = created.pipeline.intakeId;
      expect(user.state).toEqual("active");
      expect(user.type).toEqual("intake");
      expect(user.user.length).toBeGreaterThan(0);
      expect(Redacted.value(user.password)).toEqual(PASSWORD);

      // Out of band.
      const fetched = yield* intake.getIntakeUser({
        projectId,
        regionId: region,
        intakeId,
        intakeUserId: user.userId,
      });
      expect(fetched.description).toEqual("alchemy test user");
      expect(fetched.labels).toMatchObject({ env: "test", "alchemy.id": "UserUnderTest" });

      // Redeploying unchanged is a no-op, and a new password is an update.
      const plan = yield* stack.plan(app(props));
      expect(plan.resources.UserUnderTest).toMatchObject({ action: "noop" });
      const rotation = yield* stack.plan(
        app({ ...props, password: Redacted.make(`${PASSWORD}-2`) }),
      );
      expect(rotation.resources.UserUnderTest).toMatchObject({ action: "update" });

      // Everything else updates in place.
      const updated = yield* stack.deploy(
        app({
          password: Redacted.make(`${PASSWORD}-2`),
          displayName: "alchemy-test-user",
          description: "alchemy test user updated",
          type: "dead-letter",
          labels: { env: "prod" },
        }),
      );
      expect(updated.user!.userId).toEqual(user.userId);
      expect(Redacted.value(updated.user!.password)).toEqual(`${PASSWORD}-2`);
      const afterUpdate = yield* intake.getIntakeUser({
        projectId,
        regionId: region,
        intakeId,
        intakeUserId: user.userId,
      });
      expect(afterUpdate.displayName).toEqual("alchemy-test-user");
      expect(afterUpdate.type).toEqual("dead-letter");
      expect(afterUpdate.labels?.env).toEqual("prod");

      // A user of the same name without labels is refused, and left alone.
      const displayName = "alchemy-test-foreign";
      const foreign = yield* intake.createIntakeUser({
        projectId,
        regionId: region,
        intakeId,
        displayName,
        password: PASSWORD,
      });
      const refused = yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* app(props);
            return yield* Stackit.Intake.User("ForeignUser", {
              intakeId,
              displayName,
              password: Redacted.make(PASSWORD),
            });
          }),
        )
        .pipe(Effect.flip);
      expect(refused._tag).toEqual("OwnedBySomeoneElse");
      const still = yield* observeUser(projectId, region, intakeId, foreign.id);
      expect(still).not.toEqual("gone");

      // It stops the destroy too, before the intake is stuck deleting.
      const blocked = yield* stack.destroy().pipe(Effect.flip);
      expect(blocked).toMatchObject({
        _tag: "Stackit.Intake.IntakeNotEmpty",
        users: [displayName],
      });
      const pipelineAfter = yield* observeIntake(projectId, region, intakeId);
      expect(pipelineAfter).toMatchObject({ state: "active" });

      yield* intake.deleteIntakeUser({
        projectId,
        regionId: region,
        intakeId,
        intakeUserId: foreign.id,
      });
      yield* expectGone(observeUser(projectId, region, intakeId, foreign.id));

      yield* stack.destroy();
      yield* expectGone(observeUser(projectId, region, intakeId, user.userId));
      yield* expectGone(observeIntake(projectId, region, intakeId));
      yield* expectGone(observeRunner(projectId, region, created.runner.runnerId));
    }).pipe(logLevel),
  options,
);
