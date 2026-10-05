import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as edge from "@distilled.cloud/azure/edge";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getDynamicSchema = (
  resourceGroupName: string,
  schemaName: string,
  dynamicSchemaName: string,
) =>
  Effect.gen(function* () {
    return yield* edge.GetDynamicSchema({
      subscriptionId: yield* subscription,
      resourceGroupName,
      schemaName,
      dynamicSchemaName,
    });
  });

const program = (props: { name?: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const schema = yield* Azure.Edge.Schema("Schema", {
      resourceGroup: group.resourceGroupName,
    });
    const dynamic = yield* Azure.Edge.DynamicSchema("Dynamic", {
      resourceGroup: group.resourceGroupName,
      schema: schema.schemaName,
      name: props.name,
    });
    return { group, schema, dynamic };
  });

// Free control-plane resources; provision in seconds. A dynamic schema has
// no mutable properties, so there is no in-place update step.
test.provider(
  "create, replace, and delete a dynamic schema",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, schema, dynamic } = yield* stack.deploy(program({}));
      const rg = group.resourceGroupName;
      const get = (name: string) =>
        getDynamicSchema(rg, schema.schemaName, name);
      expect(dynamic.dynamicSchemaId).toContain("/dynamicSchemas/");
      expect((yield* get(dynamic.dynamicSchemaName)).name).toEqual(
        dynamic.dynamicSchemaName,
      );

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-dynamic-renamed" }),
      );
      expect(replaced.dynamic.dynamicSchemaName).toEqual(
        "alchemy-dynamic-renamed",
      );
      expect((yield* get("alchemy-dynamic-renamed")).name).toEqual(
        "alchemy-dynamic-renamed",
      );
      expect(yield* waitGone(get(dynamic.dynamicSchemaName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-dynamic-renamed"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
