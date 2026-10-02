import * as Azure from "@/Azure";
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

const getMetadata = (
  resourceGroupName: string,
  configTemplateName: string,
  configTemplateMetadataName: string,
) =>
  Effect.gen(function* () {
    return yield* edge.GetConfigTemplateMetadatas({
      subscriptionId: yield* subscription,
      resourceGroupName,
      configTemplateName,
      configTemplateMetadataName,
    });
  });

const program = (props: { linked: boolean; name?: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const context = yield* Azure.Edge.Context("Context", {
      resourceGroup: group.resourceGroupName,
      capabilities: [{ name: "soap", description: "Soap" }],
      hierarchies: [{ name: "country", description: "Country" }],
    });
    const site = yield* Azure.Edge.Site("Site", {
      resourceGroup: group.resourceGroupName,
    });
    const reference = yield* Azure.Edge.SiteReference("Reference", {
      resourceGroup: group.resourceGroupName,
      context: context.contextName,
      siteId: site.siteId,
    });
    const template = yield* Azure.Edge.ConfigTemplate("Template", {
      resourceGroup: group.resourceGroupName,
      description: "Alchemy test template",
    });
    yield* Azure.Edge.ConfigTemplateVersion("Version", {
      resourceGroup: group.resourceGroupName,
      configTemplate: template.configTemplateName,
      version: "1.0.0",
      configurations: configTemplateYaml("Greeting"),
    });
    const metadata = yield* Azure.Edge.ConfigTemplateMetadata("Metadata", {
      resourceGroup: group.resourceGroupName,
      configTemplate: template.configTemplateName,
      name: props.name,
      contextId: context.contextId,
      // Linked through the reference so the link goes before the site.
      linkedHierarchies: props.linked
        ? [
            {
              level: "country",
              hierarchyIds: [reference.siteId],
            },
          ]
        : [],
    });
    return { group, site, template, metadata };
  });

// Free control-plane resources; provision in seconds.
test.provider(
  "create, update, replace, and delete config template metadata",
  (stack) =>
    withContext(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { group, site, template, metadata } = yield* stack.deploy(
          program({ linked: true }),
        );
        const get = (name: string) =>
          getMetadata(
            group.resourceGroupName,
            template.configTemplateName,
            name,
          );
        expect(metadata.configTemplateMetadataName).toEqual("default");
        const linkedIds = (
          (yield* get("default")).properties?.linkedHierarchies ?? []
        ).flatMap((h) => h.hierarchyIds ?? []);
        expect(linkedIds.map((id) => id.toLowerCase())).toEqual([
          site.siteId.toLowerCase(),
        ]);

        // In-place: unlink the site.
        const updated = yield* stack.deploy(program({ linked: false }));
        expect(updated.metadata.configTemplateMetadataId).toEqual(
          metadata.configTemplateMetadataId,
        );
        expect(
          ((yield* get("default")).properties?.linkedHierarchies ?? []).flatMap(
            (h) => h.hierarchyIds ?? [],
          ),
        ).toEqual([]);

        // Replacement: a new name.
        const replaced = yield* stack.deploy(
          program({ linked: true, name: "alchemy-links" }),
        );
        expect(replaced.metadata.configTemplateMetadataName).toEqual(
          "alchemy-links",
        );
        expect(
          (yield* get("alchemy-links")).properties?.contextId,
        ).toBeDefined();
        expect(yield* waitGone(get("default"))).toEqual("gone");

        yield* stack.destroy();
        expect(yield* waitGone(get("alchemy-links"))).toEqual("gone");
      }),
    ).pipe(logLevel),
  { tags, timeout: 600_000 },
);
