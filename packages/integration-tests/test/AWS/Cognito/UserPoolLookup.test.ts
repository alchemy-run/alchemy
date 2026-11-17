import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as cip from "@distilled.cloud/aws/cognito-identity-provider";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:cognito", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "UserPoolLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const pool = yield* AWS.Cognito.UserPool("lookup-target");
    const client = yield* AWS.Cognito.UserPoolClient("lookup-target-client", {
      userPoolId: pool.userPoolId,
    });
    const identities = yield* AWS.Cognito.IdentityPool("lookup-target-identities");
    return {
      userPoolId: pool.userPoolId.as<string>(),
      userPoolName: pool.userPoolName.as<string>(),
      clientId: client.clientId.as<string>(),
      clientName: client.clientName.as<string>(),
      identityPoolId: identities.identityPoolId.as<string>(),
      identityPoolName: identities.identityPoolName.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up user pool resolves by id and by name, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { userPoolId, userPoolName, clientId, clientName, identityPoolId, identityPoolName } =
        yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const byName = AWS.Cognito.UserPool.lookup({ userPoolName });
          const byId = AWS.Cognito.UserPool.lookup({ userPoolId });
          return { id: byName.userPoolId, name: byId.userPoolName };
        },
        {
          id: userPoolId,
          name: userPoolName,
        },
      );
      const survivor = yield* cip.describeUserPool({ UserPoolId: userPoolId });
      expect(survivor.UserPool?.Name).toBe(userPoolName);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a looked-up app client resolves by id and by name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { userPoolId, userPoolName, clientId, clientName, identityPoolId, identityPoolName } =
        yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const byName = AWS.Cognito.UserPoolClient.lookup({ userPoolId, clientName });
          const byId = AWS.Cognito.UserPoolClient.lookup({ userPoolId, clientId });
          return { id: byName.clientId, name: byId.clientName };
        },
        {
          id: clientId,
          name: clientName,
        },
      );
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a looked-up identity pool resolves by id and by name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { userPoolId, userPoolName, clientId, clientName, identityPoolId, identityPoolName } =
        yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const byName = AWS.Cognito.IdentityPool.lookup({ identityPoolName });
          const byId = AWS.Cognito.IdentityPool.lookup({ identityPoolId });
          return { id: byName.identityPoolId, name: byId.identityPoolName };
        },
        {
          id: identityPoolId,
          name: identityPoolName,
        },
      );
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing user pool fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          AWS.SSM.Parameter("missing-user-pool", {
            value: AWS.Cognito.UserPool.lookup({ userPoolName: name }).userPoolId,
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a user pool this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => AWS.Cognito.UserPool("lookup-managed");
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-user-pool-consumer", {
              value: AWS.Cognito.UserPool.lookup({ userPoolId: attrs.userPoolId }).userPoolId,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
