import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as edge from "@distilled.cloud/azure/edge";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { location, logLevel, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getReference = (resourceUri: string) =>
  edge.GetSchemaReference({
    resourceUri,
    schemaReferenceName: "default",
  });

const program = (props: { target: "A" | "B"; scope: "A" | "B" }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const groupB = yield* Azure.Resources.ResourceGroup("GroupB", {
      location,
    });
    // One site per resource group; both stay deployed across the
    // replacement step.
    const siteA = yield* Azure.Edge.Site("Site", {
      resourceGroup: group.resourceGroupName,
    });
    const siteB = yield* Azure.Edge.Site("SiteB", {
      resourceGroup: groupB.resourceGroupName,
    });
    // Both schemas stay deployed across the update step.
    const schemaA = yield* Azure.Edge.Schema("SchemaA", {
      resourceGroup: group.resourceGroupName,
    });
    const schemaB = yield* Azure.Edge.Schema("SchemaB", {
      resourceGroup: group.resourceGroupName,
    });
    const reference = yield* Azure.Edge.SchemaReference("Reference", {
      resourceUri: props.scope === "A" ? siteA.siteId : siteB.siteId,
      schemaId: props.target === "A" ? schemaA.schemaId : schemaB.schemaId,
    });
    return { siteA, siteB, schemaA, schemaB, reference };
  });

// Free control-plane resources; provision in seconds.
// The reference name is fixed (`default`); a new scope replaces it.
test.provider(
  "create, update, replace, and delete a schema reference",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { siteA, siteB, schemaA, schemaB, reference } = yield* stack.deploy(
        program({ target: "A", scope: "A" }),
      );
      expect(reference.schemaReferenceName).toEqual("default");
      expect(
        (yield* getReference(siteA.siteId)).properties?.schemaId?.toLowerCase(),
      ).toEqual(schemaA.schemaId.toLowerCase());

      // In-place: link the other schema.
      const updated = yield* stack.deploy(program({ target: "B", scope: "A" }));
      expect(updated.reference.schemaReferenceId).toEqual(
        reference.schemaReferenceId,
      );
      expect(
        (yield* getReference(siteA.siteId)).properties?.schemaId?.toLowerCase(),
      ).toEqual(schemaB.schemaId.toLowerCase());

      // Replacement: attach to the other site.
      const replaced = yield* stack.deploy(
        program({ target: "B", scope: "B" }),
      );
      expect(replaced.reference.resourceUri).toEqual(siteB.siteId);
      expect(
        (yield* getReference(siteB.siteId)).properties?.schemaId?.toLowerCase(),
      ).toEqual(schemaB.schemaId.toLowerCase());
      expect(yield* waitGone(getReference(siteA.siteId))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(getReference(siteB.siteId))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
