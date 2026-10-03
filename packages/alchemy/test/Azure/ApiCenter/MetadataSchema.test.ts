import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apicenter from "@distilled.cloud/azure/apicenter";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { apiCenter, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: { name: string; required: boolean }) =>
  Effect.gen(function* () {
    const { group, center } = yield* apiCenter;
    const schema = yield* Azure.ApiCenter.MetadataSchema("Team", {
      resourceGroup: group.resourceGroupName,
      serviceName: center.serviceName,
      name: props.name,
      schema: { type: "string", title: "Owning team" },
      assignedTo: [{ entity: "api", required: props.required }],
    });
    return { group, center, schema };
  });

// Free-plan API Center: $0, provisions in under a minute.
test.provider(
  "create, update, replace, and delete a metadata schema",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, center, schema } = yield* stack.deploy(
        program({ name: "team", required: false }),
      );
      expect(schema.metadataSchemaName).toEqual("team");
      const get = (name: string) =>
        Effect.gen(function* () {
          return yield* apicenter.GetMetadataSchema({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            serviceName: center.serviceName,
            metadataSchemaName: name,
          });
        });
      const observed = yield* get("team");
      expect(JSON.parse(observed.properties?.schema ?? "{}")).toMatchObject({
        type: "string",
      });
      expect(observed.properties?.assignedTo?.[0]?.entity).toEqual("api");
      expect(observed.properties?.assignedTo?.[0]?.required ?? false).toEqual(
        false,
      );

      // In-place: make the property required.
      const updated = yield* stack.deploy(
        program({ name: "team", required: true }),
      );
      expect(updated.schema.metadataSchemaId).toEqual(schema.metadataSchemaId);
      expect(
        (yield* get("team")).properties?.assignedTo?.[0]?.required,
      ).toEqual(true);

      // Replacement: rename.
      const replaced = yield* stack.deploy(
        program({ name: "owner", required: true }),
      );
      expect(replaced.schema.metadataSchemaName).toEqual("owner");
      expect((yield* get("owner")).name).toEqual("owner");
      expect(yield* waitGone(get("team"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("owner"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
