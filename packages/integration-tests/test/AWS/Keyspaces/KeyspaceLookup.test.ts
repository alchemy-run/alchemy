import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as keyspaces from "@distilled.cloud/aws/keyspaces";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:keyspaces", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "KeyspaceLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const keyspace = yield* AWS.Keyspaces.Keyspace("lookup-target");
    return {
      keyspaceName: keyspace.keyspaceName.as<string>(),
      keyspaceArn: keyspace.keyspaceArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up keyspace resolves by name, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { keyspaceName, keyspaceArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          return { arn: AWS.Keyspaces.Keyspace.lookup({ keyspaceName }).keyspaceArn };
        },
        {
          arn: keyspaceArn,
        },
      );
      const survivor = yield* keyspaces.getKeyspace({ keyspaceName });
      expect(survivor.resourceArn).toBe(keyspaceArn);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing keyspace fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const lookups = {
        "missing-keyspace": AWS.Keyspaces.Keyspace.lookup({ keyspaceName: name.replace(/-/g, "_") })
          .keyspaceArn,
      };
      for (const [id, value] of Object.entries(lookups)) {
        yield* expectDeployFails(stack.deploy(AWS.SSM.Parameter(id, { value })), [
          "LookupNotFoundError",
        ]);
      }
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a keyspace this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => AWS.Keyspaces.Keyspace("lookup-managed");
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-keyspace-consumer", {
              value: AWS.Keyspaces.Keyspace.lookup({ keyspaceName: attrs.keyspaceName })
                .keyspaceArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
