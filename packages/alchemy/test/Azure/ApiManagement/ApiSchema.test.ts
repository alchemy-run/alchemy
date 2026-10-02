import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  consumptionApi,
  logLevel,
  subscriptionId,
  tags,
  untilGone,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSchema = (
  resourceGroupName: string,
  serviceName: string,
  apiId: string,
  schemaId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetApiSchema({
      subscriptionId,
      resourceGroupName,
      serviceName,
      apiId,
      schemaId,
    }),
  );

const components = (field: string) => ({
  schemas: {
    Order: {
      type: "object",
      properties: { [field]: { type: "string" } },
    },
  },
});

const program = (schema?: { name: string; field: string }) =>
  Effect.gen(function* () {
    const { group, service, api } = yield* consumptionApi;
    const created = schema
      ? yield* Azure.ApiManagement.ApiSchema("Orders", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          apiName: api.apiName,
          name: schema.name,
          contentType: "application/vnd.oai.openapi.components+json",
          components: components(schema.field),
        })
      : undefined;
    return { group, service, api, schema: created };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "create, update, replace, and delete an API schema",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({ name: "orders", field: "id" }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      const api = first.api.apiName;
      expect(first.schema?.schemaName).toEqual("orders");
      const observed = yield* getSchema(rg, svc, api, "orders");
      expect(observed.properties?.contentType).toEqual(
        "application/vnd.oai.openapi.components+json",
      );
      expect(JSON.stringify(observed.properties?.document)).toContain('"id"');

      // In-place update of the document.
      yield* stack.deploy(program({ name: "orders", field: "total" }));
      const updated = yield* getSchema(rg, svc, api, "orders");
      expect(JSON.stringify(updated.properties?.document)).toContain('"total"');

      // Replacement: a new identifier creates a new schema, deletes the old.
      const replaced = yield* stack.deploy(
        program({ name: "orders-v2", field: "total" }),
      );
      expect(replaced.schema?.schemaName).toEqual("orders-v2");
      expect(yield* untilGone(getSchema(rg, svc, api, "orders"))).toEqual(
        "gone",
      );

      // Removing the resource deletes the schema.
      yield* stack.deploy(program());
      expect(yield* untilGone(getSchema(rg, svc, api, "orders-v2"))).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
