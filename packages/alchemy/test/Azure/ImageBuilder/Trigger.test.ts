import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as imagebuilder from "@distilled.cloud/azure/imagebuilder";
import * as resources from "@distilled.cloud/azure/resources";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getTrigger = (
  resourceGroupName: string,
  imageTemplateName: string,
  triggerName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* imagebuilder.GetTrigger({
      subscriptionId,
      resourceGroupName,
      imageTemplateName,
      triggerName,
    });
  });

const triggerGone = (
  resourceGroupName: string,
  imageTemplateName: string,
  triggerName: string,
) =>
  getTrigger(resourceGroupName, imageTemplateName, triggerName).pipe(
    Effect.as("found" as const),
    // `NotFound`: the parent template is already gone with the trigger.
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

/**
 * Out-of-band Azure Compute Gallery source (alchemy has no gallery resource
 * yet): an empty 4 GB disk, its snapshot, a gallery, an image definition and
 * one version. A `SourceImage` trigger needs a template whose source is a
 * real `SharedImageVersion` on `latest`. Deleted with the resource group.
 */
const galleryTemplate = {
  $schema:
    "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  contentVersion: "1.0.0.0",
  resources: [
    {
      type: "Microsoft.Compute/disks",
      apiVersion: "2023-10-02",
      name: "base-os",
      location: "eastus",
      sku: { name: "Standard_LRS" },
      properties: {
        creationData: { createOption: "Empty" },
        diskSizeGB: 4,
        osType: "Linux",
        hyperVGeneration: "V2",
      },
    },
    {
      type: "Microsoft.Compute/snapshots",
      apiVersion: "2023-10-02",
      name: "base-os-snap",
      location: "eastus",
      sku: { name: "Standard_LRS" },
      dependsOn: ["[resourceId('Microsoft.Compute/disks', 'base-os')]"],
      properties: {
        creationData: {
          createOption: "Copy",
          sourceResourceId: "[resourceId('Microsoft.Compute/disks', 'base-os')]",
        },
      },
    },
    {
      type: "Microsoft.Compute/galleries",
      apiVersion: "2023-07-03",
      name: "base",
      location: "eastus",
      properties: {},
    },
    {
      type: "Microsoft.Compute/galleries/images",
      apiVersion: "2023-07-03",
      name: "base/ubuntu",
      location: "eastus",
      dependsOn: ["[resourceId('Microsoft.Compute/galleries', 'base')]"],
      properties: {
        osType: "Linux",
        osState: "Generalized",
        hyperVGeneration: "V2",
        identifier: { publisher: "alchemy", offer: "test", sku: "base" },
      },
    },
    {
      type: "Microsoft.Compute/galleries/images/versions",
      apiVersion: "2023-07-03",
      name: "base/ubuntu/1.0.0",
      location: "eastus",
      dependsOn: [
        "[resourceId('Microsoft.Compute/galleries/images', 'base', 'ubuntu')]",
        "[resourceId('Microsoft.Compute/snapshots', 'base-os-snap')]",
      ],
      properties: {
        storageProfile: {
          osDiskImage: {
            source: {
              id: "[resourceId('Microsoft.Compute/snapshots', 'base-os-snap')]",
            },
          },
        },
        publishingProfile: {
          targetRegions: [
            {
              name: "eastus",
              regionalReplicaCount: 1,
              storageAccountType: "Standard_LRS",
            },
          ],
        },
      },
    },
  ],
};

const deployGallery = (resourceGroupName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const where = {
      subscriptionId,
      resourceGroupName,
      deploymentName: "imagebuilder-trigger-gallery",
    };
    yield* resources.DeploymentsCreateOrUpdate({
      ...where,
      properties: { mode: "Incremental", template: galleryTemplate },
    });
    const done = yield* resources.GetDeployment(where).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("10 seconds"),
        until: (d) =>
          d.properties?.provisioningState === "Succeeded" ||
          d.properties?.provisioningState === "Failed" ||
          d.properties?.provisioningState === "Canceled",
        times: 60,
      }),
    );
    expect(done.properties?.provisioningState).toEqual("Succeeded");
  });

const base = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity(
    "Builder",
    { resourceGroup: group.resourceGroupName },
  );
  // Image Builder reads the gallery source as the template identity.
  yield* Azure.Authorization.RoleAssignment("BuilderContributor", {
    scope: group.resourceGroupId,
    roleDefinitionId: Azure.Authorization.BuiltInRole.Contributor,
    principalId: identity.principalId,
    principalType: "ServicePrincipal",
  });
  return { group, identity };
});

const program = (triggerName: string) =>
  Effect.gen(function* () {
    const { group, identity } = yield* base;
    const template = yield* Azure.ImageBuilder.ImageTemplate("App", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      identityId: identity.identityId,
      source: {
        type: "SharedImageVersion",
        imageVersionId: Output.interpolate`${group.resourceGroupId}/providers/Microsoft.Compute/galleries/base/images/ubuntu/versions/latest`,
      },
      distribute: [
        {
          type: "ManagedImage",
          runOutputName: "app",
          imageId: Output.interpolate`${group.resourceGroupId}/providers/Microsoft.Compute/images/app`,
          location: "eastus",
        },
      ],
    });
    const trigger = yield* Azure.ImageBuilder.Trigger("OnBaseUpdate", {
      resourceGroup: group.resourceGroupName,
      name: triggerName,
      imageTemplate: template.imageTemplateName,
    });
    return { group, template, trigger };
  });

// No build runs. Cost: a 4 GB disk + snapshot + one gallery image version
// for ~15 minutes (< $0.05), but ~13–15 min wall clock: the gallery version
// replicates for ~7 min and the resource group holding it takes ~5 min to
// delete. Gated as expensive (> 10 min).
test.provider.skipIf(!runExpensive)(
  "create, replace, and delete an image builder trigger",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group: baseGroup } = yield* stack.deploy(base);
      yield* deployGallery(baseGroup.resourceGroupName);

      const created = yield* stack.deploy(program("on-base-update"));
      const { group, template, trigger } = created;
      expect(trigger.kind).toEqual("SourceImage");
      expect(trigger.provisioningState).toEqual("Succeeded");
      const observed = yield* getTrigger(
        group.resourceGroupName,
        template.imageTemplateName,
        trigger.triggerName,
      );
      expect(observed.properties?.kind).toEqual("SourceImage");
      expect(observed.id?.toLowerCase()).toEqual(trigger.triggerId.toLowerCase());

      // Renaming replaces the trigger; a template allows one SourceImage
      // trigger, so the old one is deleted first.
      const renamed = yield* stack.deploy(program("on-base-release"));
      expect(renamed.trigger.triggerName).not.toEqual(trigger.triggerName);
      yield* getTrigger(
        group.resourceGroupName,
        template.imageTemplateName,
        renamed.trigger.triggerName,
      );
      expect(
        yield* triggerGone(
          group.resourceGroupName,
          template.imageTemplateName,
          trigger.triggerName,
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* triggerGone(
          group.resourceGroupName,
          template.imageTemplateName,
          renamed.trigger.triggerName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:imagebuilder", "live"],
    timeout: 900_000,
  },
);
