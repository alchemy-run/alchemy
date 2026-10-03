import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as edge from "@distilled.cloud/azure/edge";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  configTemplateYaml,
  location,
  logLevel,
  subscription,
  tags,
  waitGone,
  withContext,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getDynamic = (
  resourceGroupName: string,
  configurationName: string,
  dynamicConfigurationName: string,
) =>
  Effect.gen(function* () {
    return yield* edge.GetDynamicConfiguration({
      subscriptionId: yield* subscription,
      resourceGroupName,
      configurationName,
      dynamicConfigurationName,
    });
  });

const program = (props: { currentVersion: string; template: "A" | "B" }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    // Both templates stay deployed across the replacement step.
    const templateA = yield* Azure.Edge.ConfigTemplate("TemplateA", {
      resourceGroup: group.resourceGroupName,
      description: "Alchemy test template A",
    });
    const templateB = yield* Azure.Edge.ConfigTemplate("TemplateB", {
      resourceGroup: group.resourceGroupName,
      description: "Alchemy test template B",
    });
    yield* Azure.Edge.ConfigTemplateVersion("VersionA", {
      resourceGroup: group.resourceGroupName,
      configTemplate: templateA.configTemplateName,
      version: "1.0.0",
      configurations: configTemplateYaml("Greeting"),
    });
    yield* Azure.Edge.ConfigTemplateVersion("VersionB", {
      resourceGroup: group.resourceGroupName,
      configTemplate: templateB.configTemplateName,
      version: "1.0.0",
      configurations: configTemplateYaml("Greeting"),
    });
    const configuration = yield* Azure.Edge.Configuration("Configuration", {
      resourceGroup: group.resourceGroupName,
    });
    // The service resolves a template only when it is linked to a hierarchy
    // entity whose configuration reference points at the configuration.
    const context = yield* Azure.Edge.Context("Context", {
      resourceGroup: group.resourceGroupName,
      capabilities: [{ name: "soap", description: "Soap" }],
      hierarchies: [{ name: "country", description: "Country" }],
    });
    const site = yield* Azure.Edge.Site("Site", {
      resourceGroup: group.resourceGroupName,
    });
    const siteReference = yield* Azure.Edge.SiteReference("SiteReference", {
      resourceGroup: group.resourceGroupName,
      context: context.contextName,
      siteId: site.siteId,
    });
    const configurationReference = yield* Azure.Edge.ConfigurationReference(
      "ConfigurationReference",
      {
        resourceUri: siteReference.siteId,
        configurationResourceId: configuration.configurationId,
      },
    );
    const metadataA = yield* Azure.Edge.ConfigTemplateMetadata("MetadataA", {
      resourceGroup: group.resourceGroupName,
      configTemplate: templateA.configTemplateName,
      contextId: context.contextId,
      linkedHierarchies: [
        { level: "country", hierarchyIds: [siteReference.siteId] },
      ],
    });
    const metadataB = yield* Azure.Edge.ConfigTemplateMetadata("MetadataB", {
      resourceGroup: group.resourceGroupName,
      configTemplate: templateB.configTemplateName,
      contextId: context.contextId,
      linkedHierarchies: [
        { level: "country", hierarchyIds: [siteReference.siteId] },
      ],
    });
    const template = props.template === "A" ? templateA : templateB;
    const metadata = props.template === "A" ? metadataA : metadataB;
    const dynamic = yield* Azure.Edge.DynamicConfiguration("Dynamic", {
      resourceGroup: group.resourceGroupName,
      configuration: configuration.configurationName,
      // Named through the link and the reference so it is created after both.
      name: Output.all(
        template.uniqueIdentifier,
        metadata.configTemplateMetadataId,
        configurationReference.configurationReferenceId,
      ).pipe(Output.map(([uid]) => uid as string)),
      currentVersion: props.currentVersion,
    });
    return { group, configuration, templateA, templateB, dynamic };
  });

// Free control-plane resources; configurations take ~2 minutes to delete.
test.provider(
  "create, update, replace, and delete a dynamic configuration",
  (stack) =>
    withContext(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { group, configuration, templateA, templateB, dynamic } =
          yield* stack.deploy(
            program({ currentVersion: "1.0.0", template: "A" }),
          );
        const get = (name: string) =>
          getDynamic(
            group.resourceGroupName,
            configuration.configurationName,
            name,
          );
        expect(dynamic.dynamicConfigurationName).toEqual(
          templateA.uniqueIdentifier,
        );
        expect(
          (yield* get(dynamic.dynamicConfigurationName)).properties,
        ).toMatchObject({ currentVersion: "1.0.0" });

        // In-place: the current version.
        yield* stack.deploy(
          program({ currentVersion: "1.0.1", template: "A" }),
        );
        expect(
          (yield* get(dynamic.dynamicConfigurationName)).properties
            ?.currentVersion,
        ).toEqual("1.0.1");

        // Replacement: configure the other template.
        const replaced = yield* stack.deploy(
          program({ currentVersion: "1.0.1", template: "B" }),
        );
        expect(replaced.dynamic.dynamicConfigurationName).toEqual(
          templateB.uniqueIdentifier,
        );
        expect(
          (yield* get(templateB.uniqueIdentifier!)).properties?.currentVersion,
        ).toEqual("1.0.1");
        expect(yield* waitGone(get(dynamic.dynamicConfigurationName))).toEqual(
          "gone",
        );

        yield* stack.destroy();
        expect(yield* waitGone(get(templateB.uniqueIdentifier!))).toEqual(
          "gone",
        );
      }),
    ).pipe(logLevel),
  { tags, timeout: 900_000 },
);
