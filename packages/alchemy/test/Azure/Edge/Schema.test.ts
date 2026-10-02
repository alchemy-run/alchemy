import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as edge from "@distilled.cloud/azure/edge";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSchema = (resourceGroupName: string, schemaName: string) =>
  Effect.gen(function* () {
    return yield* edge.GetSchema({
      subscriptionId: yield* subscription,
      resourceGroupName,
      schemaName,
    });
  });

const program = (props: { name?: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const schema = yield* Azure.Edge.Schema("Schema", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      tags: props.tags,
    });
    return { group, schema };
  });

// Free control-plane resource; provisions in seconds.
test.provider(
  "create, update, replace, and delete a schema",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, schema } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      const rg = group.resourceGroupName;
      expect(schema.location).toEqual(location);
      const observed = yield* getSchema(rg, schema.schemaName);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Schema");

      // In-place: tags.
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.schema.schemaId).toEqual(schema.schemaId);
      expect((yield* getSchema(rg, schema.schemaName)).tags?.env).toEqual(
        "prod",
      );

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-schema-renamed", tags: { env: "prod" } }),
      );
      expect(replaced.schema.schemaName).toEqual("alchemy-schema-renamed");
      expect(
        (yield* getSchema(rg, "alchemy-schema-renamed")).tags?.env,
      ).toEqual("prod");
      expect(yield* waitGone(getSchema(rg, schema.schemaName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(getSchema(rg, "alchemy-schema-renamed"))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
