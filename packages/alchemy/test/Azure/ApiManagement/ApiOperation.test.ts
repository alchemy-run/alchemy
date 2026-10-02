import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  consumptionService,
  logLevel,
  subscriptionId,
  tags,
  untilGone,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getOperation = (
  resourceGroupName: string,
  serviceName: string,
  apiId: string,
  operationId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetApiOperation({
      subscriptionId,
      resourceGroupName,
      serviceName,
      apiId,
      operationId,
    }),
  );

const program = (operation?: {
  name: string;
  displayName: string;
  urlTemplate: string;
}) =>
  Effect.gen(function* () {
    const { group, service } = yield* consumptionService;
    const api = yield* Azure.ApiManagement.Api("Hello", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-hello",
      path: "hello",
      serviceUrl: "https://example.com",
    });
    const created = operation
      ? yield* Azure.ApiManagement.ApiOperation("Greet", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          apiName: api.apiName,
          name: operation.name,
          displayName: operation.displayName,
          method: "GET",
          urlTemplate: operation.urlTemplate,
          templateParameters: operation.urlTemplate.includes("{name}")
            ? [{ name: "name", type: "string", required: true }]
            : undefined,
          responses: [{ statusCode: 200, description: "Greeting" }],
        })
      : undefined;
    return { group, service, api, operation: created };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "create, update, replace, and delete an API operation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({
          name: "greet",
          displayName: "Greet",
          urlTemplate: "/hello",
        }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      const api = first.api.apiName;
      expect(first.operation?.operationName).toEqual("greet");
      const observed = yield* getOperation(rg, svc, api, "greet");
      expect(observed.properties?.method).toEqual("GET");
      expect(observed.properties?.urlTemplate).toEqual("/hello");
      expect(observed.properties?.displayName).toEqual("Greet");
      expect(observed.properties?.responses?.[0]?.statusCode).toEqual(200);

      // In-place update: URL template (with a parameter) and display name.
      yield* stack.deploy(
        program({
          name: "greet",
          displayName: "Greet by name",
          urlTemplate: "/hello/{name}",
        }),
      );
      const updated = yield* getOperation(rg, svc, api, "greet");
      expect(updated.properties?.urlTemplate).toEqual("/hello/{name}");
      expect(updated.properties?.displayName).toEqual("Greet by name");
      expect(updated.properties?.templateParameters?.[0]?.name).toEqual("name");

      // Replacement: a new identifier creates a new operation.
      const replaced = yield* stack.deploy(
        program({
          name: "greet-v2",
          displayName: "Greet v2",
          urlTemplate: "/v2/hello",
        }),
      );
      expect(replaced.operation?.operationName).toEqual("greet-v2");
      expect(
        (yield* getOperation(rg, svc, api, "greet-v2")).properties?.urlTemplate,
      ).toEqual("/v2/hello");
      expect(yield* untilGone(getOperation(rg, svc, api, "greet"))).toEqual(
        "gone",
      );

      // Removing the operation deletes it while the API stays.
      yield* stack.deploy(program());
      expect(yield* untilGone(getOperation(rg, svc, api, "greet-v2"))).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
