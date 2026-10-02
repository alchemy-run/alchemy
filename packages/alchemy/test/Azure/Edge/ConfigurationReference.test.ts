import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as edge from "@distilled.cloud/azure/edge";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { location, logLevel, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getReference = (resourceUri: string) =>
  edge.GetConfigurationReference({
    resourceUri,
    configurationReferenceName: "default",
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
    // Both configurations stay deployed across the update step.
    const configA = yield* Azure.Edge.Configuration("ConfigA", {
      resourceGroup: group.resourceGroupName,
    });
    const configB = yield* Azure.Edge.Configuration("ConfigB", {
      resourceGroup: group.resourceGroupName,
    });
    const reference = yield* Azure.Edge.ConfigurationReference("Reference", {
      resourceUri: props.scope === "A" ? siteA.siteId : siteB.siteId,
      configurationResourceId:
        props.target === "A"
          ? configA.configurationId
          : configB.configurationId,
    });
    return { siteA, siteB, configA, configB, reference };
  });

// Free control-plane resources; configurations take ~1-2 minutes to delete.
// The reference name is fixed (`default`); a new scope replaces it.
test.provider(
  "create, update, replace, and delete a configuration reference",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { siteA, siteB, configA, configB, reference } = yield* stack.deploy(
        program({ target: "A", scope: "A" }),
      );
      expect(reference.configurationReferenceName).toEqual("default");
      expect(
        (yield* getReference(
          siteA.siteId,
        )).properties?.configurationResourceId?.toLowerCase(),
      ).toEqual(configA.configurationId.toLowerCase());

      // In-place: link the other configuration.
      const updated = yield* stack.deploy(program({ target: "B", scope: "A" }));
      expect(updated.reference.configurationReferenceId).toEqual(
        reference.configurationReferenceId,
      );
      expect(
        (yield* getReference(
          siteA.siteId,
        )).properties?.configurationResourceId?.toLowerCase(),
      ).toEqual(configB.configurationId.toLowerCase());

      // Replacement: attach to the other site.
      const replaced = yield* stack.deploy(
        program({ target: "B", scope: "B" }),
      );
      expect(replaced.reference.resourceUri).toEqual(siteB.siteId);
      expect(
        (yield* getReference(
          siteB.siteId,
        )).properties?.configurationResourceId?.toLowerCase(),
      ).toEqual(configB.configurationId.toLowerCase());
      expect(yield* waitGone(getReference(siteA.siteId))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(getReference(siteB.siteId))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
