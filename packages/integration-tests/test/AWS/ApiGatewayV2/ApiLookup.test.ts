import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as agw2 from "@distilled.cloud/aws/apigatewayv2";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:apigatewayv2", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "ApiV2LookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const api = yield* AWS.ApiGatewayV2.Api("lookup-target");
    return {
      apiId: api.apiId.as<string>(),
      apiName: api.name.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up API resolves by id and by name, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { apiId, apiName } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const byName = AWS.ApiGatewayV2.Api.lookup({ name: apiName });
          const byId = AWS.ApiGatewayV2.Api.lookup({ apiId });
          return { id: byName.apiId, name: byId.name };
        },
        {
          id: apiId,
          name: apiName,
        },
      );
      const survivor = yield* agw2.getApi({ ApiId: apiId });
      expect(survivor.Name).toBe(apiName);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing API fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          AWS.SSM.Parameter("missing-API", {
            value: AWS.ApiGatewayV2.Api.lookup({ name }).apiId,
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of an API this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => AWS.ApiGatewayV2.Api("lookup-managed");
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-API-consumer", {
              value: AWS.ApiGatewayV2.Api.lookup({ apiId: attrs.apiId }).apiId,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
