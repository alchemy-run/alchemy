import * as Azure from "@/Azure";
import { orUndefinedIfNotFound } from "@/Azure/Arm";
import * as Test from "@/Test/Alchemy";
import * as resources from "@distilled.cloud/azure/resources";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const template = (greeting: string) => ({
  $schema:
    "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  contentVersion: "1.0.0.0",
  resources: [],
  outputs: { greeting: { type: "string", value: greeting } },
});

const getVersion = (
  resourceGroupName: string,
  templateSpecName: string,
  templateSpecVersion: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* orUndefinedIfNotFound(
      resources.GetTemplateSpecVersion({
        subscriptionId,
        resourceGroupName,
        templateSpecName,
        templateSpecVersion,
      }),
    );
  });

const versionGone = (group: string, spec: string, version: string) =>
  getVersion(group, spec, version).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (observed) => observed === undefined,
      times: 10,
    }),
  );

const program = (version: string, greeting: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const spec = yield* Azure.Resources.TemplateSpec("Spec", {
      resourceGroup: group.resourceGroupName,
    });
    const version_ = yield* Azure.Resources.TemplateSpecVersion("Version", {
      resourceGroup: group.resourceGroupName,
      templateSpecName: spec.templateSpecName,
      name: version,
      description: `says ${greeting}`,
      mainTemplate: template(greeting),
      tags: { greeting },
    });
    return { group, spec, version: version_ };
  });

test.provider(
  "publish, update, replace, and delete a template spec version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, spec, version } = yield* stack.deploy(
        program("1.0.0", "hello"),
      );
      expect(version.version).toEqual("1.0.0");
      expect(version.location).toEqual("eastus");
      expect(version.templateSpecVersionId).toMatch(
        /\/templateSpecs\/.+\/versions\/1\.0\.0$/,
      );
      const observed = yield* getVersion(
        group.resourceGroupName,
        spec.templateSpecName,
        "1.0.0",
      );
      expect(JSON.stringify(observed?.properties.mainTemplate)).toContain(
        "hello",
      );

      // Template content, description and tags are mutable in place.
      yield* stack.deploy(program("1.0.0", "howdy"));
      const reobserved = yield* getVersion(
        group.resourceGroupName,
        spec.templateSpecName,
        "1.0.0",
      );
      expect(JSON.stringify(reobserved?.properties.mainTemplate)).toContain(
        "howdy",
      );
      expect(reobserved?.properties.description).toEqual("says howdy");
      expect(reobserved?.tags?.greeting).toEqual("howdy");

      // A new version label replaces the version.
      const next = yield* stack.deploy(program("2.0.0", "howdy"));
      expect(next.version.version).toEqual("2.0.0");
      expect(
        yield* versionGone(
          group.resourceGroupName,
          spec.templateSpecName,
          "1.0.0",
        ),
      ).toBeUndefined();

      yield* stack.destroy();
      expect(
        yield* versionGone(
          group.resourceGroupName,
          spec.templateSpecName,
          "2.0.0",
        ),
      ).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:resources", "live"],
    timeout: 600_000,
  },
);
