import * as AWS from "@/AWS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as ag from "@distilled.cloud/aws/api-gateway";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

test.provider.skipIf(!!process.env.FAST)("create and delete stage", (stack) =>
  Effect.gen(function* () {
    const { stage } = yield* stack.deploy(
      Effect.gen(function* () {
        const api = yield* AWS.ApiGateway.RestApi("AgStageApi", {
          endpointConfiguration: { types: ["REGIONAL"] },
        });
        yield* AWS.ApiGateway.Method("AgStageMock", {
          restApi: api,
          httpMethod: "GET",
          authorizationType: "NONE",
          integration: { type: "MOCK" },
        });
        const deployment = yield* AWS.ApiGateway.Deployment("AgStageDep", {
          restApi: api,
        });
        const stage = yield* AWS.ApiGateway.Stage("AgStageDev", {
          restApi: api,
          stageName: "dev",
          deploymentId: deployment.deploymentId,
        });
        return { stage };
      }),
    );

    expect(stage.stageName).toEqual("dev");

    yield* stack.destroy();
  }),
);

test.provider.skipIf(!!process.env.FAST)(
  "stage variables update in place",
  (stack) =>
    Effect.gen(function* () {
      const { api } = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* AWS.ApiGateway.RestApi("AgStageVarApi", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });
          yield* AWS.ApiGateway.Method("AgStageVarMock", {
            restApi: api,
            httpMethod: "GET",
            authorizationType: "NONE",
            integration: { type: "MOCK" },
          });
          const deployment = yield* AWS.ApiGateway.Deployment("AgStageVarDep", {
            restApi: api,
          });
          const stage = yield* AWS.ApiGateway.Stage("AgStageVar", {
            restApi: api,
            stageName: "dev",
            deploymentId: deployment.deploymentId,
            variables: { K: "1" },
          });
          return { api, stage, deployment };
        }),
      );

      yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* AWS.ApiGateway.RestApi("AgStageVarApi", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });
          yield* AWS.ApiGateway.Method("AgStageVarMock", {
            restApi: api,
            httpMethod: "GET",
            authorizationType: "NONE",
            integration: { type: "MOCK" },
          });
          const deployment = yield* AWS.ApiGateway.Deployment("AgStageVarDep", {
            restApi: api,
          });
          yield* AWS.ApiGateway.Stage("AgStageVar", {
            restApi: api,
            stageName: "dev",
            deploymentId: deployment.deploymentId,
            variables: { K: "2" },
          });
          return undefined;
        }),
      );

      const remote = yield* ag.getStage({
        restApiId: api.restApiId,
        stageName: "dev",
      });
      expect(remote.variables?.K).toEqual("2");

      yield* stack.destroy();
    }),
);

test.provider.skipIf(!!process.env.FAST)(
  "stage method settings update in place",
  (stack) =>
    Effect.gen(function* () {
      const { api } = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* AWS.ApiGateway.RestApi("AgStageMethodApi", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });
          yield* AWS.ApiGateway.Method("AgStageMethodMock", {
            restApi: api,
            httpMethod: "GET",
            authorizationType: "NONE",
            integration: { type: "MOCK" },
          });
          const deployment = yield* AWS.ApiGateway.Deployment(
            "AgStageMethodDep",
            {
              restApi: api,
            },
          );
          yield* AWS.ApiGateway.Stage("AgStageMethod", {
            restApi: api,
            stageName: "dev",
            deploymentId: deployment.deploymentId,
            methodSettings: {
              "*/*": { throttlingBurstLimit: 10, throttlingRateLimit: 100 },
            },
          });
          return { api };
        }),
      );

      yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* AWS.ApiGateway.RestApi("AgStageMethodApi", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });
          yield* AWS.ApiGateway.Method("AgStageMethodMock", {
            restApi: api,
            httpMethod: "GET",
            authorizationType: "NONE",
            integration: { type: "MOCK" },
          });
          const deployment = yield* AWS.ApiGateway.Deployment(
            "AgStageMethodDep",
            {
              restApi: api,
            },
          );
          yield* AWS.ApiGateway.Stage("AgStageMethod", {
            restApi: api,
            stageName: "dev",
            deploymentId: deployment.deploymentId,
            methodSettings: {
              "*/*": { throttlingBurstLimit: 20, throttlingRateLimit: 200 },
            },
          });
          return undefined;
        }),
      );

      const remote = yield* ag.getStage({
        restApiId: api.restApiId,
        stageName: "dev",
      });
      expect(remote.methodSettings?.["*/*"]?.throttlingBurstLimit).toEqual(20);
      expect(remote.methodSettings?.["*/*"]?.throttlingRateLimit).toEqual(200);

      yield* stack.destroy();
    }),
);

// Canonical `list()` test: deploy a real stage (plus its parent RestApi +
// Deployment), resolve the typed provider from context, call `list()`, and
// assert the deployed stage appears in the result (enumerated by walking
// every parent RestApi then listing stages per api).
test.provider.skipIf(!!process.env.FAST)(
  "list enumerates the deployed stage",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { stage } = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* AWS.ApiGateway.RestApi("AgStageListApi", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });
          yield* AWS.ApiGateway.Method("AgStageListMock", {
            restApi: api,
            httpMethod: "GET",
            authorizationType: "NONE",
            integration: { type: "MOCK" },
          });
          const deployment = yield* AWS.ApiGateway.Deployment(
            "AgStageListDep",
            {
              restApi: api,
            },
          );
          const stage = yield* AWS.ApiGateway.Stage("AgStageListDev", {
            restApi: api,
            stageName: "dev",
            deploymentId: deployment.deploymentId,
          });
          return { stage };
        }),
      );

      const provider = yield* Provider.findProvider(
        AWS.ApiGateway.StageResource,
      );
      const all = yield* provider.list();

      expect(
        all.some(
          (s) =>
            s.restApiId === stage.restApiId && s.stageName === stage.stageName,
        ),
      ).toBe(true);

      yield* stack.destroy();
    }),
);
