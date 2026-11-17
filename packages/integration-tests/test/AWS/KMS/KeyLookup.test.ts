import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as kms from "@distilled.cloud/aws/kms";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:kms", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "KeyLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const key = yield* AWS.KMS.Key("lookup-target", { deletionWindow: "7 days" });
    const alias = yield* AWS.KMS.Alias("lookup-target-alias", { targetKeyId: key.keyId });
    return {
      keyId: key.keyId.as<string>(),
      keyArn: key.keyArn.as<string>(),
      aliasName: alias.aliasName.as<string>(),
      aliasArn: alias.aliasArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up key resolves by id, ARN and alias, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { keyId, keyArn, aliasName, aliasArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const byId = AWS.KMS.Key.lookup({ keyId });
          const byArn = AWS.KMS.Key.lookup({ keyId: keyArn });
          const byAlias = AWS.KMS.Key.lookup({ keyId: aliasName });
          return { arn: byId.keyArn, id: byArn.keyId, aliasKey: byAlias.keyId };
        },
        {
          arn: keyArn,
          id: keyId,
          aliasKey: keyId,
        },
      );
      const survivor = yield* kms.describeKey({ KeyId: keyId });
      expect(survivor.KeyMetadata?.KeyState).toBe("Enabled");
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a looked-up alias resolves by name to its key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { keyId, keyArn, aliasName, aliasArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const alias = AWS.KMS.Alias.lookup({ aliasName });
          return { arn: alias.aliasArn, target: alias.targetKeyId };
        },
        {
          arn: aliasArn,
          target: keyId,
        },
      );
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing key fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          AWS.SSM.Parameter("missing-key", {
            value: AWS.KMS.Key.lookup({ keyId: `alias/${name}` }).keyArn,
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a key this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => AWS.KMS.Key("lookup-managed", { deletionWindow: "7 days" });
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-key-consumer", {
              value: AWS.KMS.Key.lookup({ keyId: attrs.keyId }).keyArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
