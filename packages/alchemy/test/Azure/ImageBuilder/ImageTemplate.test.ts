import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as imagebuilder from "@distilled.cloud/azure/imagebuilder";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getTemplate = (resourceGroupName: string, imageTemplateName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* imagebuilder.GetVirtualMachineImageTemplate({
      subscriptionId,
      resourceGroupName,
      imageTemplateName,
    });
  });

const templateGone = (resourceGroupName: string, imageTemplateName: string) =>
  getTemplate(resourceGroupName, imageTemplateName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (props: {
  step: string;
  osDiskSizeGB: number;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity(
      "Builder",
      { resourceGroup: group.resourceGroupName },
    );
    const template = yield* Azure.ImageBuilder.ImageTemplate("Web", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      identityId: identity.identityId,
      source: {
        type: "PlatformImage",
        publisher: "Canonical",
        offer: "ubuntu-24_04-lts",
        sku: "server",
        version: "latest",
      },
      customize: [
        { type: "Shell", name: props.step, inline: [`echo ${props.step}`] },
      ],
      distribute: [
        {
          type: "ManagedImage",
          runOutputName: "web",
          imageId: Output.interpolate`${group.resourceGroupId}/providers/Microsoft.Compute/images/web`,
          location: "eastus",
          artifactTags: { source: "alchemy-test" },
        },
      ],
      vmProfile: { osDiskSizeGB: props.osDiskSizeGB },
      tags: props.tags,
    });
    return { group, identity, template };
  });

// Template only (no build): free apart from a few cents of staging storage;
// create ~1–3 min, delete ~3–10 min (the IT_* staging group is torn down).
test.provider(
  "create, update, replace, and delete an image template",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ step: "hello", osDiskSizeGB: 30, tags: { env: "test" } }),
      );
      const { group, identity, template } = created;
      expect(template.provisioningState).toEqual("Succeeded");
      expect(template.tags).toEqual({ env: "test" });

      const observed = yield* getTemplate(
        group.resourceGroupName,
        template.imageTemplateName,
      );
      expect(observed.properties?.source).toMatchObject({
        type: "PlatformImage",
        publisher: "Canonical",
        offer: "ubuntu-24_04-lts",
      });
      expect(observed.properties?.customize?.[0]).toMatchObject({
        type: "Shell",
        name: "hello",
        inline: ["echo hello"],
      });
      expect(observed.properties?.distribute?.[0]).toMatchObject({
        type: "ManagedImage",
        runOutputName: "web",
      });
      expect(observed.properties?.vmProfile?.osDiskSizeGB).toEqual(30);
      expect(
        Object.keys(observed.identity.userAssignedIdentities ?? {}).map((k) =>
          k.toLowerCase(),
        ),
      ).toEqual([identity.identityId.toLowerCase()]);
      expect(observed.properties?.exactStagingResourceGroup).toMatch(
        /\/resourceGroups\/IT_/i,
      );

      // In-place: vmProfile and tags are PATCHed.
      const updated = yield* stack.deploy(
        program({ step: "hello", osDiskSizeGB: 64, tags: { env: "prod" } }),
      );
      expect(updated.template.imageTemplateId).toEqual(template.imageTemplateId);
      const reobserved = yield* getTemplate(
        group.resourceGroupName,
        template.imageTemplateName,
      );
      expect(reobserved.properties?.vmProfile?.osDiskSizeGB).toEqual(64);
      expect(reobserved.tags?.env).toEqual("prod");

      // Customizers are immutable: changing them replaces the template.
      const replaced = yield* stack.deploy(
        program({ step: "world", osDiskSizeGB: 64, tags: { env: "prod" } }),
      );
      expect(replaced.template.imageTemplateName).not.toEqual(
        template.imageTemplateName,
      );
      const replacement = yield* getTemplate(
        group.resourceGroupName,
        replaced.template.imageTemplateName,
      );
      expect(replacement.properties?.customize?.[0]).toMatchObject({
        name: "world",
      });
      expect(
        yield* templateGone(group.resourceGroupName, template.imageTemplateName),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* templateGone(
          group.resourceGroupName,
          replaced.template.imageTemplateName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:imagebuilder", "live"],
    timeout: 900_000,
  },
);
