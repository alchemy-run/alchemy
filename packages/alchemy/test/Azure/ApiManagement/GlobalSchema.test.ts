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

const getSchema = (
  resourceGroupName: string,
  serviceName: string,
  schemaId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetGlobalSchema({
      subscriptionId,
      resourceGroupName,
      serviceName,
      schemaId,
    }),
  );

const program = (schema?: { name: string; field: string }) =>
  Effect.gen(function* () {
    const { group, service } = yield* consumptionService;
    const created = schema
      ? yield* Azure.ApiManagement.GlobalSchema("Order", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          name: schema.name,
          schemaType: "json",
          description: "Order payload",
          document: {
            type: "object",
            required: [schema.field],
            properties: { [schema.field]: { type: "integer" } },
          },
        })
      : undefined;
    return { group, service, schema: created };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "create, update, replace, and delete a global schema",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({ name: "alchemy-order", field: "id" }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.schema?.schemaName).toEqual("alchemy-order");
      expect(first.schema?.schemaType).toEqual("json");
      expect(
        JSON.stringify((yield* getSchema(rg, svc, "alchemy-order")).properties),
      ).toContain('"id"');

      // In-place update of the document.
      yield* stack.deploy(program({ name: "alchemy-order", field: "total" }));
      expect(
        JSON.stringify((yield* getSchema(rg, svc, "alchemy-order")).properties),
      ).toContain('"total"');

      // Replacement: a new identifier creates a new schema.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-order-v2", field: "total" }),
      );
      expect(replaced.schema?.schemaName).toEqual("alchemy-order-v2");
      expect(yield* untilGone(getSchema(rg, svc, "alchemy-order"))).toEqual(
        "gone",
      );

      // Removing the resource deletes the schema.
      yield* stack.deploy(program());
      expect(yield* untilGone(getSchema(rg, svc, "alchemy-order-v2"))).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
