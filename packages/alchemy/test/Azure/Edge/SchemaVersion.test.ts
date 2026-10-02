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
  schemaVersionName: string,
) =>
  Effect.gen(function* () {
    return yield* edge.GetSchemaVersion({
      subscriptionId: yield* subscription,
      resourceGroupName,
      schemaName,
      schemaVersionName,
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
    const version = yield* Azure.Edge.SchemaVersion("Version", {
      resourceGroup: group.resourceGroupName,
      schema: schema.schemaName,
      version: props.version,
      value: rules(props.key),
    });
    return { group, schema, version };
  });

// Free control-plane resources; provision in seconds.
test.provider(
  "create, replace, and delete a schema version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, schema, version } = yield* stack.deploy(
        program({ version: "1.0.0", key: "Greeting" }),
      );
      const rg = group.resourceGroupName;
      const get = (name: string) => getVersion(rg, schema.schemaName, name);
      expect(version.schemaVersionId).toContain("/versions/1.0.0");
      expect((yield* get("1.0.0")).properties?.value).toEqual(
        rules("Greeting"),
      );

      // Replacement under the same name: a new payload (delete first).
      yield* stack.deploy(program({ version: "1.0.0", key: "Farewell" }));
      expect((yield* get("1.0.0")).properties?.value).toEqual(
        rules("Farewell"),
      );

      // Replacement under a new name.
      const bumped = yield* stack.deploy(
        program({ version: "1.0.1", key: "Farewell" }),
      );
      expect(bumped.version.version).toEqual("1.0.1");
      expect((yield* get("1.0.1")).properties?.value).toEqual(
        rules("Farewell"),
      );
      expect(yield* waitGone(get("1.0.0"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("1.0.1"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
