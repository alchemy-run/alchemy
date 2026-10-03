import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as edge from "@distilled.cloud/azure/edge";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getTemplate = (resourceGroupName: string, configTemplateName: string) =>
  Effect.gen(function* () {
    return yield* edge.GetConfigTemplate({
      subscriptionId: yield* subscription,
      resourceGroupName,
      configTemplateName,
    });
  });

const program = (props: {
  name?: string;
  description: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const template = yield* Azure.Edge.ConfigTemplate("Template", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      description: props.description,
      tags: props.tags,
    });
    return { group, template };
  });

// Free control-plane resource; provisions in seconds.
test.provider(
  "create, update, replace, and delete a config template",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, template } = yield* stack.deploy(
        program({ description: "first", tags: { env: "test" } }),
      );
      const rg = group.resourceGroupName;
      expect(template.uniqueIdentifier).toBeDefined();
      const observed = yield* getTemplate(rg, template.configTemplateName);
      expect(observed.properties?.description).toEqual("first");
      expect(observed.tags?.["alchemy::id"]).toEqual("Template");

      // In-place: description and tags.
      const updated = yield* stack.deploy(
        program({ description: "second", tags: { env: "prod" } }),
      );
      expect(updated.template.configTemplateId).toEqual(
        template.configTemplateId,
      );
      const reobserved = yield* getTemplate(rg, template.configTemplateName);
      expect(reobserved.properties?.description).toEqual("second");
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-ct-renamed",
          description: "second",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.template.configTemplateName).toEqual(
        "alchemy-ct-renamed",
      );
      expect(
        (yield* getTemplate(rg, "alchemy-ct-renamed")).properties?.description,
      ).toEqual("second");
      expect(
        yield* waitGone(getTemplate(rg, template.configTemplateName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(getTemplate(rg, "alchemy-ct-renamed"))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
