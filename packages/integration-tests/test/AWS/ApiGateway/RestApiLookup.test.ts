import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:apigateway", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "RestApiLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const api = yield* AWS.ApiGateway.RestApi("lookup-target");
    return {
      restApiId: api.restApiId.as<string>(),
      apiName: api.name.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up REST API resolves by id and by name, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { restApiId, apiName } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const byName = AWS.ApiGateway.RestApi.lookup({ name: apiName });
          const byId = AWS.ApiGateway.RestApi.lookup({ restApiId });
          return { id: byName.restApiId, name: byId.name };
        },
        {
          id: restApiId,
          name: apiName,
        },
      );
      const survivor = yield* ag.getRestApi({ restApiId });
      expect(survivor.name).toBe(apiName);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing REST API fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          AWS.SSM.Parameter("missing-REST-API", {
            value: AWS.ApiGateway.RestApi.lookup({ name }).restApiId,
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a REST API this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => AWS.ApiGateway.RestApi("lookup-managed");
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-REST-API-consumer", {
              value: AWS.ApiGateway.RestApi.lookup({ restApiId: attrs.restApiId }).restApiId,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
