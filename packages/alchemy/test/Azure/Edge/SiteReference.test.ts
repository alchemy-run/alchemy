import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as edge from "@distilled.cloud/azure/edge";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  location,
  logLevel,
  subscription,
  tags,
  waitGone,
  withContext,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getReference = (
  resourceGroupName: string,
  contextName: string,
  siteReferenceName: string,
) =>
  Effect.gen(function* () {
    return yield* edge.GetSiteReference({
      subscriptionId: yield* subscription,
      resourceGroupName,
      contextName,
      siteReferenceName,
    });
  });

const program = (props: { site: "A" | "B"; name?: string }) =>
  Effect.gen(function* () {
    // One site per resource group, so each site gets its own group.
    const groupA = yield* Azure.Resources.ResourceGroup("GroupA", {
      location,
    });
    const groupB = yield* Azure.Resources.ResourceGroup("GroupB", {
      location,
    });
    const context = yield* Azure.Edge.Context("Context", {
      resourceGroup: groupA.resourceGroupName,
      capabilities: [{ name: "soap", description: "Soap" }],
      hierarchies: [{ name: "country", description: "Country" }],
    });
    // Both sites stay deployed across the update and replacement steps.
    const siteA = yield* Azure.Edge.Site("SiteA", {
      resourceGroup: groupA.resourceGroupName,
    });
    const siteB = yield* Azure.Edge.Site("SiteB", {
      resourceGroup: groupB.resourceGroupName,
    });
    const reference = yield* Azure.Edge.SiteReference("Reference", {
      resourceGroup: groupA.resourceGroupName,
      context: context.contextName,
      name: props.name,
      siteId: props.site === "A" ? siteA.siteId : siteB.siteId,
    });
    return { groupA, context, siteA, siteB, reference };
  });

// Free control-plane resources; provision in seconds.
test.provider(
  "create, update, replace, and delete a site reference",
  (stack) =>
    withContext(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { groupA, context, siteA, siteB, reference } =
          yield* stack.deploy(program({ site: "A" }));
        const get = (name: string) =>
          getReference(groupA.resourceGroupName, context.contextName, name);
        expect(reference.siteId.toLowerCase()).toEqual(
          siteA.siteId.toLowerCase(),
        );
        expect(
          (yield* get(
            reference.siteReferenceName,
          )).properties?.siteId?.toLowerCase(),
        ).toEqual(siteA.siteId.toLowerCase());

        // In-place: point at the other site.
        const updated = yield* stack.deploy(program({ site: "B" }));
        expect(updated.reference.siteReferenceId).toEqual(
          reference.siteReferenceId,
        );
        expect(
          (yield* get(
            reference.siteReferenceName,
          )).properties?.siteId?.toLowerCase(),
        ).toEqual(siteB.siteId.toLowerCase());

        // Replacement: a new name.
        const replaced = yield* stack.deploy(
          program({ site: "B", name: "alchemy-ref-renamed" }),
        );
        expect(replaced.reference.siteReferenceName).toEqual(
          "alchemy-ref-renamed",
        );
        expect(
          (yield* get("alchemy-ref-renamed")).properties?.siteId?.toLowerCase(),
        ).toEqual(siteB.siteId.toLowerCase());
        expect(yield* waitGone(get(reference.siteReferenceName))).toEqual(
          "gone",
        );

        yield* stack.destroy();
        expect(yield* waitGone(get("alchemy-ref-renamed"))).toEqual("gone");
      }),
    ).pipe(logLevel),
  { tags, timeout: 600_000 },
);
