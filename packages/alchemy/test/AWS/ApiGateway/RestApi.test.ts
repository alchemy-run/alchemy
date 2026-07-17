import * as AWS from "@/AWS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as ag from "@distilled.cloud/aws/api-gateway";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

test.provider.skipIf(!!process.env.FAST)(
  "create and delete REST API",
  (stack) =>
    Effect.gen(function* () {
      const api = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.RestApi("AgRestApiLifecycle", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });
        }),
      );

      expect(api.restApiId).toBeDefined();
      expect(api.rootResourceId).toBeDefined();

      const remote = yield* ag.getRestApi({ restApiId: api.restApiId });
      expect(remote.id).toEqual(api.restApiId);

      yield* stack.destroy();
    }),
);

test.provider.skipIf(!!process.env.FAST)(
  "binary media types update applies via patch",
  (stack) =>
    Effect.gen(function* () {
      const api = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.RestApi("AgRestApiBinary", {
            endpointConfiguration: { types: ["REGIONAL"] },
            binaryMediaTypes: ["application/octet-stream"],
          });
        }),
      );

      expect(api.binaryMediaTypes?.includes("application/octet-stream")).toBe(
        true,
      );

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.RestApi("AgRestApiBinary", {
            endpointConfiguration: { types: ["REGIONAL"] },
            binaryMediaTypes: ["application/octet-stream", "image/png"],
          });
        }),
      );

      const remote = yield* ag.getRestApi({ restApiId: api.restApiId });
      expect(remote.binaryMediaTypes?.includes("image/png")).toBe(true);

      yield* stack.destroy();
    }),
);

test.provider.skipIf(!!process.env.FAST)(
  "binary media types removal applies via patch",
  (stack) =>
    Effect.gen(function* () {
      const api = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.RestApi("AgRestApiBinaryRemoval", {
            endpointConfiguration: { types: ["REGIONAL"] },
            binaryMediaTypes: ["application/octet-stream", "image/png"],
          });
        }),
      );

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.RestApi("AgRestApiBinaryRemoval", {
            endpointConfiguration: { types: ["REGIONAL"] },
            binaryMediaTypes: ["image/png"],
          });
        }),
      );

      const remote = yield* ag.getRestApi({ restApiId: api.restApiId });
      expect(remote.binaryMediaTypes?.includes("image/png")).toBe(true);
      expect(
        remote.binaryMediaTypes?.includes("application/octet-stream"),
      ).toBe(false);

      yield* stack.destroy();
    }),
);

// Canonical `list()` test (AWS account/region-scoped collection): deploy a
// real REST API, resolve the typed provider via `findProvider`, call `list()`,
// and assert the deployed API appears in the exhaustively-paginated result.
test.provider.skipIf(!!process.env.FAST)(
  "list enumerates the deployed REST API",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const api = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.RestApi("AgRestApiList", {
            endpointConfiguration: { types: ["REGIONAL"] },
          });
        }),
      );

      const provider = yield* Provider.findProvider(AWS.ApiGateway.RestApi);
      const all = yield* provider.list();

      expect(all.some((a) => a.restApiId === api.restApiId)).toBe(true);

      yield* stack.destroy();
    }),
);
