import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as edge from "@distilled.cloud/azure/edge";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  configTemplateYaml as rules,
  location,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getVersion = (
  resourceGroupName: string,
  configTemplateName: string,
  configTemplateVersionName: string,
) =>
  Effect.gen(function* () {
    return yield* edge.GetConfigTemplateVersion({
      subscriptionId: yield* subscription,
      resourceGroupName,
      configTemplateName,
      configTemplateVersionName,
    });
  });

const program = (props: { version: string; key: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const template = yield* Azure.Edge.ConfigTemplate("Template", {
      resourceGroup: group.resourceGroupName,
      description: "Alchemy test template",
    });
    const version = yield* Azure.Edge.ConfigTemplateVersion("Version", {
      resourceGroup: group.resourceGroupName,
      configTemplate: template.configTemplateName,
      version: props.version,
      configurations: rules(props.key),
    });
    return { group, template, version };
  });

// Free control-plane resources; provision in seconds.
test.provider(
  "create, replace, and delete a config template version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, template, version } = yield* stack.deploy(
        program({ version: "1.0.0", key: "Greeting" }),
      );
      const rg = group.resourceGroupName;
      const get = (name: string) =>
        getVersion(rg, template.configTemplateName, name);
      expect(version.configTemplateVersionId).toContain("/versions/1.0.0");
      expect((yield* get("1.0.0")).properties?.configurations).toEqual(
        rules("Greeting"),
      );

      // Replacement under the same name: a new payload (delete first).
      yield* stack.deploy(program({ version: "1.0.0", key: "Farewell" }));
      expect((yield* get("1.0.0")).properties?.configurations).toEqual(
        rules("Farewell"),
      );

      // Replacement under a new name.
      const bumped = yield* stack.deploy(
        program({ version: "1.0.1", key: "Farewell" }),
      );
      expect(bumped.version.version).toEqual("1.0.1");
      expect((yield* get("1.0.1")).properties?.configurations).toEqual(
        rules("Farewell"),
      );
      expect(yield* waitGone(get("1.0.0"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("1.0.1"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
