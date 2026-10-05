import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as devcenter from "@distilled.cloud/azure/devcenter";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getGallery = (
  resourceGroupName: string,
  devCenterName: string,
  galleryName: string,
) =>
  Effect.gen(function* () {
    return yield* devcenter.GetGallery({
      subscriptionId: yield* subscription,
      resourceGroupName,
      devCenterName,
      galleryName,
    });
  });

/** Two empty Azure Compute Galleries (free); the SDK has no gallery ops. */
const computeGalleries = {
  $schema:
    "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  contentVersion: "1.0.0.0",
  resources: ["alchemydcone", "alchemydctwo"].map((name) => ({
    type: "Microsoft.Compute/galleries",
    apiVersion: "2022-03-03",
    name,
    location: "[resourceGroup().location]",
    properties: {},
  })),
  outputs: {
    one: {
      type: "string",
      value: "[resourceId('Microsoft.Compute/galleries', 'alchemydcone')]",
    },
    two: {
      type: "string",
      value: "[resourceId('Microsoft.Compute/galleries', 'alchemydctwo')]",
    },
  },
};

const program = (props: { computeGallery: "one" | "two" }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const center = yield* Azure.DevCenter.DevCenter("Center", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      identity: { type: "SystemAssigned" },
    });
    const deployment = yield* Azure.Resources.Deployment("ComputeGalleries", {
      resourceGroup: group.resourceGroupName,
      template: computeGalleries,
    });
    const access = yield* Azure.Authorization.RoleAssignment("GalleryAccess", {
      scope: group.resourceGroupId,
      roleDefinitionId: Azure.Authorization.BuiltInRole.Contributor,
      principalId: Output.map(center.principalId, (id) => id ?? ""),
      principalType: "ServicePrincipal",
    });
    const gallery = yield* Azure.DevCenter.Gallery("Gallery", {
      resourceGroup: group.resourceGroupName,
      devCenter: center.devCenterName,
      // Depend on the role assignment so the dev center can read the gallery.
      galleryResourceId: Output.map(
        Output.all(deployment.outputs, access.roleAssignmentId),
        ([outputs]) => outputs[props.computeGallery] as string,
      ),
    });
    return { group, center, deployment, gallery };
  });

// Dev centers and compute galleries are free; ~12 minutes in total (the dev
// center create and delete dominate, plus RBAC propagation), $0.
test.provider(
  "attach, replace, and detach a compute gallery",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, center, deployment, gallery } = yield* stack.deploy(
        program({ computeGallery: "one" }),
      );
      expect(gallery.galleryResourceId.toLowerCase()).toEqual(
        String(deployment.outputs.one).toLowerCase(),
      );
      const observed = yield* getGallery(
        group.resourceGroupName,
        center.devCenterName,
        gallery.galleryName,
      );
      expect(observed.id).toEqual(gallery.galleryId);
      expect(observed.properties?.galleryResourceId?.toLowerCase()).toEqual(
        String(deployment.outputs.one).toLowerCase(),
      );

      // Replacement: the backing compute gallery is immutable.
      const replaced = yield* stack.deploy(program({ computeGallery: "two" }));
      expect(replaced.gallery.galleryName).not.toEqual(gallery.galleryName);
      expect(replaced.gallery.galleryResourceId.toLowerCase()).toEqual(
        String(deployment.outputs.two).toLowerCase(),
      );
      expect(
        yield* waitGone(
          getGallery(
            group.resourceGroupName,
            center.devCenterName,
            gallery.galleryName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getGallery(
            group.resourceGroupName,
            center.devCenterName,
            replaced.gallery.galleryName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 1_800_000 },
);
