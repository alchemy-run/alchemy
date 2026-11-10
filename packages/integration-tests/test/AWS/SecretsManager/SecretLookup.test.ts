import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as secrets from "@distilled.cloud/aws/secrets-manager";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:secretsmanager", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "SecretLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const secret = yield* AWS.SecretsManager.Secret("lookup-target", {
      description: "lookup target",
    });
    return {
      secretName: secret.secretName.as<string>(),
      secretArn: secret.secretArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up secret resolves by name and by ARN, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { secretName, secretArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const byName = AWS.SecretsManager.Secret.lookup({ secretName });
          const byArn = AWS.SecretsManager.Secret.lookup({ secretArn });
          return { arn: byName.secretArn, name: byArn.secretName };
        },
        {
          arn: secretArn,
          name: secretName,
        },
      );
      const survivor = yield* secrets.describeSecret({ SecretId: secretArn });
      expect(survivor.Name).toBe(secretName);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing secret fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          AWS.SSM.Parameter("missing-secret", {
            value: AWS.SecretsManager.Secret.lookup({ secretName: name }).secretArn,
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a secret this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () =>
        AWS.SecretsManager.Secret("lookup-managed", { description: "lookup managed" });
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-secret-consumer", {
              value: AWS.SecretsManager.Secret.lookup({ secretName: attrs.secretName }).secretArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
