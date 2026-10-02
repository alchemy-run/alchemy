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
    const template = props.template === "A" ? templateA : templateB;
    const dynamic = yield* Azure.Edge.DynamicConfiguration("Dynamic", {
      resourceGroup: group.resourceGroupName,
      configuration: configuration.configurationName,
      name: template.uniqueIdentifier.as<string>(),
      currentVersion: props.currentVersion,
    });
    return { group, configuration, templateA, templateB, dynamic };
  });

// Free control-plane resources; configurations take ~2 minutes to delete.
test.provider(
  "create, update, replace, and delete a dynamic configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, configuration, templateA, templateB, dynamic } =
        yield* stack.deploy(program({ currentVersion: "1.0.0", template: "A" }));
      const get = (name: string) =>
        getDynamic(group.resourceGroupName, configuration.configurationName, name);
      expect(dynamic.dynamicConfigurationName).toEqual(
        templateA.uniqueIdentifier,
      );
      expect((yield* get(dynamic.dynamicConfigurationName)).properties).toMatchObject(
        { currentVersion: "1.0.0" },
      );

      // In-place: the current version.
      yield* stack.deploy(program({ currentVersion: "1.0.1", template: "A" }));
      expect(
        (yield* get(dynamic.dynamicConfigurationName)).properties?.currentVersion,
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
      expect(yield* waitGone(get(templateB.uniqueIdentifier!))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
