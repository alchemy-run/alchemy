import * as Azure from "@alchemy.run/azure";
import * as edge from "@distilled.cloud/azure/edge";
import { expect } from "alchemy-test";
import * as Output from "alchemy/Output";
import * as Test from "alchemy/Test/Alchemy";
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

const getVersion = (
  resourceGroupName: string,
  configurationName: string,
  dynamicConfigurationName: string,
  dynamicConfigurationVersionName: string,
) =>
  Effect.gen(function* () {
    return yield* edge.GetDynamicConfigurationVersion({
      subscriptionId: yield* subscription,
      resourceGroupName,
      configurationName,
      dynamicConfigurationName,
      dynamicConfigurationVersionName,
    });
  });

const values = (greeting: string) => `Greeting: ${greeting}\n`;

const program = (props: { version: string; greeting: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const template = yield* Azure.Edge.ConfigTemplate("Template", {
      resourceGroup: group.resourceGroupName,
      description: "Alchemy test template",
    });
    const templateVersion = yield* Azure.Edge.ConfigTemplateVersion("TemplateVersion", {
      resourceGroup: group.resourceGroupName,
      configTemplate: template.configTemplateName,
      version: "1.0.0",
      configurations: configTemplateYaml("Greeting"),
    });
    // A dynamic configuration version must name an existing template version.
    // Versions of one template provision one at a time.
    const templateVersionNext = yield* Azure.Edge.ConfigTemplateVersion("TemplateVersionNext", {
      resourceGroup: group.resourceGroupName,
      configTemplate: Output.all(
        template.configTemplateName,
        templateVersion.configTemplateVersionId,
      ).pipe(Output.map(([name]) => name)),
      version: "1.0.1",
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
    const metadata = yield* Azure.Edge.ConfigTemplateMetadata("Metadata", {
      resourceGroup: group.resourceGroupName,
      configTemplate: template.configTemplateName,
      contextId: context.contextId,
      linkedHierarchies: [{ level: "country", hierarchyIds: [siteReference.siteId] }],
    });
    const dynamic = yield* Azure.Edge.DynamicConfiguration("Dynamic", {
      resourceGroup: group.resourceGroupName,
      configuration: configuration.configurationName,
      // Named through the link, the reference, and both template versions so
      // it is created after all of them.
      name: Output.all(
        template.uniqueIdentifier,
        metadata.configTemplateMetadataId,
        configurationReference.configurationReferenceId,
        templateVersion.configTemplateVersionId,
        templateVersionNext.configTemplateVersionId,
      ).pipe(Output.map(([uid]) => uid as string)),
      currentVersion: "1.0.0",
    });
    const version = yield* Azure.Edge.DynamicConfigurationVersion("Version", {
      resourceGroup: group.resourceGroupName,
      configuration: configuration.configurationName,
      dynamicConfiguration: dynamic.dynamicConfigurationName,
      version: props.version,
      values: values(props.greeting),
    });
    return { group, configuration, dynamic, version };
  });

// Free control-plane resources; configurations take ~2 minutes to delete.
test.provider(
  "create, update, replace, and delete a dynamic configuration version",
  (stack) =>
    withContext(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { group, configuration, dynamic, version } = yield* stack.deploy(
          program({ version: "1.0.0", greeting: "hello" }),
        );
        const get = (name: string) =>
          getVersion(
            group.resourceGroupName,
            configuration.configurationName,
            dynamic.dynamicConfigurationName,
            name,
          );
        expect(version.dynamicConfigurationVersionId).toContain("/versions/1.0.0");
        expect(version.values).toEqual(values("hello"));
        expect((yield* get("1.0.0")).properties?.values).toEqual(values("hello"));

        // In-place: new values.
        const changed = yield* stack.deploy(program({ version: "1.0.0", greeting: "bye" }));
        expect(changed.version.dynamicConfigurationVersionId).toEqual(
          version.dynamicConfigurationVersionId,
        );
        expect(changed.version.values).toEqual(values("bye"));
        expect((yield* get("1.0.0")).properties?.values).toEqual(values("bye"));

        // Replacement under a new name.
        const bumped = yield* stack.deploy(program({ version: "1.0.1", greeting: "bye" }));
        expect(bumped.version.version).toEqual("1.0.1");
        expect((yield* get("1.0.1")).properties?.values).toEqual(values("bye"));
        expect(yield* waitGone(get("1.0.0"))).toEqual("gone");

        yield* stack.destroy();
        expect(yield* waitGone(get("1.0.1"))).toEqual("gone");
      }),
    ).pipe(logLevel),
  { tags, timeout: 900_000 },
);
