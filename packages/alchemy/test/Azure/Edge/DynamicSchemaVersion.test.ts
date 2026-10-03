import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as edge from "@distilled.cloud/azure/edge";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getVersion = (
  resourceGroupName: string,
  schemaName: string,
  dynamicSchemaName: string,
  dynamicSchemaVersionName: string,
) =>
  Effect.gen(function* () {
    return yield* edge.GetDynamicSchemaVersion({
      subscriptionId: yield* subscription,
      resourceGroupName,
      schemaName,
      dynamicSchemaName,
      dynamicSchemaVersionName,
    });
  });

const rules = (key: string) =>
  `rules:\n  configs:\n    ${key}:\n      type: string\n      required: true\n`;

const program = (props: { version: string; key: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const schema = yield* Azure.Edge.Schema("Schema", {
      resourceGroup: group.resourceGroupName,
    });
    const dynamic = yield* Azure.Edge.DynamicSchema("Dynamic", {
      resourceGroup: group.resourceGroupName,
      schema: schema.schemaName,
    });
    const version = yield* Azure.Edge.DynamicSchemaVersion("Version", {
      resourceGroup: group.resourceGroupName,
      schema: schema.schemaName,
      dynamicSchema: dynamic.dynamicSchemaName,
      version: props.version,
      value: rules(props.key),
    });
    return { group, schema, dynamic, version };
  });

// Free control-plane resources; provision in seconds.
test.provider(
  "create, replace, and delete a dynamic schema version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, schema, dynamic, version } = yield* stack.deploy(
        program({ version: "1.0.0", key: "Greeting" }),
      );
      const get = (name: string) =>
        getVersion(
          group.resourceGroupName,
          schema.schemaName,
          dynamic.dynamicSchemaName,
          name,
        );
      expect(version.dynamicSchemaVersionId).toContain("/versions/1.0.0");
      expect((yield* get("1.0.0")).properties?.value).toEqual(
        rules("Greeting"),
      );

      // Replacement under the same name: a new payload (delete first).
      yield* stack.deploy(program({ version: "1.0.0", key: "Farewell" }));
      expect((yield* get("1.0.0")).properties?.value).toEqual(
        rules("Farewell"),
      );

      // Replacement under a new name.
      yield* stack.deploy(program({ version: "1.0.1", key: "Farewell" }));
      expect((yield* get("1.0.1")).properties?.value).toEqual(
        rules("Farewell"),
      );
      expect(yield* waitGone(get("1.0.0"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("1.0.1"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
