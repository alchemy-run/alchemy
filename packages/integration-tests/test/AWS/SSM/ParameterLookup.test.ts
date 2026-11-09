import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ssm from "@distilled.cloud/aws/ssm";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:ssm", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "ParameterLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const parameter = yield* AWS.SSM.Parameter("lookup-target", { value: "looked-up" });
    return {
      parameterName: parameter.parameterName.as<string>(),
      parameterArn: parameter.parameterArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up parameter resolves by name, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { parameterName, parameterArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const parameter = AWS.SSM.Parameter.lookup({ parameterName });
          return { arn: parameter.parameterArn };
        },
        {
          arn: parameterArn,
        },
      );
      const survivor = yield* ssm.getParameter({ Name: parameterName });
      expect(survivor.Parameter?.ARN).toBe(parameterArn);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing parameter fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          AWS.SSM.Parameter("missing-parameter", {
            value: AWS.SSM.Parameter.lookup({ parameterName: `/${name}` }).parameterArn,
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a parameter this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => AWS.SSM.Parameter("lookup-managed", { value: "managed" });
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-parameter-consumer", {
              value: AWS.SSM.Parameter.lookup({ parameterName: attrs.parameterName }).parameterArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
