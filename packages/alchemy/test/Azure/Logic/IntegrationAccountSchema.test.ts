import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as logic from "@distilled.cloud/azure/logic";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { freeAccount, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const xsd = (ns: string) =>
  `<?xml version="1.0" encoding="utf-8"?><xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="${ns}"><xs:element name="Order" type="xs:string"/></xs:schema>`;

const program = (props: { name?: string; ns: string; owner: string }) =>
  Effect.gen(function* () {
    // One Free account per region per subscription: this file owns westus3.
    const { group, account } = yield* freeAccount("westus3");
    const schema = yield* Azure.Logic.IntegrationAccountSchema("Order", {
      resourceGroup: group.resourceGroupName,
      integrationAccount: account.integrationAccountName,
      name: props.name,
      content: xsd(props.ns),
      metadata: { owner: props.owner },
    });
    return { group, account, schema };
  });

const getSchema = (rg: string, account: string, schemaName: string) =>
  Effect.gen(function* () {
    return yield* logic.GetIntegrationAccountSchema({
      subscriptionId: yield* subscription,
      resourceGroupName: rg,
      integrationAccountName: account,
      schemaName,
    });
  });

// Free integration account: no cost, synchronous.
test.provider(
  "create, update, replace, and delete an integration account schema",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, schema } = yield* stack.deploy(
        program({ ns: "http://contoso/v1", owner: "a" }),
      );
      const rg = group.resourceGroupName;
      const ia = account.integrationAccountName;
      expect(schema.targetNamespace).toEqual("http://contoso/v1");
      expect(schema.documentName).toEqual("Order");
      expect(schema.metadata).toEqual({ owner: "a" });
      const observed = yield* getSchema(rg, ia, schema.schemaName);
      const metadata = observed.properties.metadata as Record<string, unknown>;
      expect(metadata.owner).toEqual("a");
      expect(metadata["alchemy::id"]).toEqual("Order");

      // In-place: content (never echoed; detected via the metadata hash).
      const updated = yield* stack.deploy(
        program({ ns: "http://contoso/v2", owner: "b" }),
      );
      expect(updated.schema.schemaId).toEqual(schema.schemaId);
      const reobserved = yield* getSchema(rg, ia, schema.schemaName);
      expect(reobserved.properties.targetNamespace).toEqual("http://contoso/v2");
      expect(
        (reobserved.properties.metadata as Record<string, unknown>).owner,
      ).toEqual("b");

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program({ name: "order-v2", ns: "http://contoso/v2", owner: "b" }),
      );
      expect(replaced.schema.schemaName).toEqual("order-v2");
      expect(yield* waitGone(getSchema(rg, ia, schema.schemaName))).toEqual(
        "gone",
      );
      const replacedObserved = yield* getSchema(rg, ia, "order-v2");
      expect(replacedObserved.properties.targetNamespace).toEqual(
        "http://contoso/v2",
      );

      yield* stack.destroy();
      expect(yield* waitGone(getSchema(rg, ia, "order-v2"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
