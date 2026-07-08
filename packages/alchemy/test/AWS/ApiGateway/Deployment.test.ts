import * as AWS from "@/AWS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

test.provider.skipIf(!!process.env.FAST)(
  "create and delete deployment",
  (stack) =>
    Effect.gen(function* () {
      const { deployment } = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* AWS.ApiGateway.RestApi("AgDepApi", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });
          yield* AWS.ApiGateway.Method("AgDepMock", {
            restApi: api,
            httpMethod: "GET",
            authorizationType: "NONE",
            integration: { type: "MOCK" },
          });
          const deployment = yield* AWS.ApiGateway.Deployment("AgDep", {
            restApi: api,
            description: "alchemy-test-deployment",
          });
          return { api, deployment };
        }),
      );

      expect(deployment.deploymentId).toBeDefined();

      yield* stack.destroy();
    }),
);

test.provider.skipIf(!!process.env.FAST)(
  "deployment trigger change creates new deployment",
  (stack) =>
    Effect.gen(function* () {
      const { d1 } = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* AWS.ApiGateway.RestApi("AgTrigApi", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });
          yield* AWS.ApiGateway.Method("AgTrigMock", {
            restApi: api,
            httpMethod: "GET",
            authorizationType: "NONE",
            integration: { type: "MOCK" },
          });
          const deployment = yield* AWS.ApiGateway.Deployment("AgTrigDep", {
            restApi: api,
            description: "v1",
            triggers: { t: "a" },
          });
          return { api, d1: deployment };
        }),
      );

      const { d2 } = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* AWS.ApiGateway.RestApi("AgTrigApi", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });
          yield* AWS.ApiGateway.Method("AgTrigMock", {
            restApi: api,
            httpMethod: "GET",
            authorizationType: "NONE",
            integration: { type: "MOCK" },
          });
          const deployment = yield* AWS.ApiGateway.Deployment("AgTrigDep", {
            restApi: api,
            description: "v1",
            triggers: { t: "b" },
          });
          return { d2: deployment };
        }),
      );

      expect(d2.deploymentId).not.toEqual(d1.deploymentId);

      yield* stack.destroy();
    }),
);

test.provider.skipIf(!!process.env.FAST)(
  "list enumerates the deployed deployment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { deployment } = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* AWS.ApiGateway.RestApi("AgListApi", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });
          yield* AWS.ApiGateway.Method("AgListMock", {
            restApi: api,
            httpMethod: "GET",
            authorizationType: "NONE",
            integration: { type: "MOCK" },
          });
          const deployment = yield* AWS.ApiGateway.Deployment("AgListDep", {
            restApi: api,
            description: "alchemy-test-list-deployment",
          });
          return { api, deployment };
        }),
      );

      const provider = yield* Provider.findProvider(
        AWS.ApiGateway.DeploymentResource,
      );
      const all = yield* provider.list();

      expect(all.some((d) => d.deploymentId === deployment.deploymentId)).toBe(
        true,
      );

      yield* stack.destroy();
    }),
);
