import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as lambda from "@distilled.cloud/aws/lambda";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:lambda", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "FunctionLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* AWS.Lambda.Function("lookup-target", {
      main: new URL("./fixtures/lookup-target-handler.ts", import.meta.url).pathname,
      isExternal: true,
      handler: "handler",
      functionUrl: false,
    });
    return {
      functionName: fn.functionName.as<string>(),
      functionArn: fn.functionArn.as<string>(),
      roleArn: fn.roleArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up function resolves by name and by ARN, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { functionName, functionArn, roleArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const byName = AWS.Lambda.Function.lookup({ functionName });
          const byArn = AWS.Lambda.Function.lookup({ functionName: functionArn });
          return { arn: byName.functionArn, role: byArn.roleArn };
        },
        {
          arn: functionArn,
          role: roleArn,
        },
      );
      const survivor = yield* lambda.getFunction({ FunctionName: functionName });
      expect(survivor.Configuration?.FunctionArn).toBe(functionArn);
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "a lookup of a missing function fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          AWS.SSM.Parameter("missing-function", {
            value: AWS.Lambda.Function.lookup({ functionName: name }).functionArn,
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "a lookup of a function this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () =>
        AWS.Lambda.Function("lookup-managed", {
          main: new URL("./fixtures/lookup-target-handler.ts", import.meta.url).pathname,
          isExternal: true,
          handler: "handler",
          functionUrl: false,
        });
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-function-consumer", {
              value: AWS.Lambda.Function.lookup({ functionName: attrs.functionName }).functionArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 180_000 },
);
