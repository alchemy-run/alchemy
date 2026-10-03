import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as discovery from "@distilled.cloud/azure/discovery";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  location,
  logLevel,
  probeGroup,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getTool = (resourceGroupName: string, toolName: string) =>
  Effect.gen(function* () {
    return yield* discovery.GetTool({
      subscriptionId: yield* subscription,
      resourceGroupName,
      toolName,
    });
  });

const program = (props: {
  location: string;
  version: string;
  environmentVariables?: Record<string, string>;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const tool = yield* Azure.Discovery.Tool("Tool", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      version: props.version,
      definitionContent: { name: "alchemy-test", image: "busybox:latest" },
      environmentVariables: props.environmentVariables,
      tags: props.tags,
    });
    return { group, tool };
  });

// Microsoft Discovery is a gated preview: the trial subscription can
// register Microsoft.Discovery, but ARM does not expose the resource types
// (InvalidResourceType, see the probe below). A tool is a control-plane
// definition (~$0); runs only with AZURE_TEST_PAID=1 on an onboarded
// subscription.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete a discovery tool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, tool } = yield* stack.deploy(
        program({ location, version: "1.0.0", tags: { env: "test" } }),
      );
      const observed = yield* getTool(group.resourceGroupName, tool.toolName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.version).toEqual("1.0.0");
      expect(observed.tags?.env).toEqual("test");

      // In place: version, environment, tags.
      const updated = yield* stack.deploy(
        program({
          location,
          version: "1.1.0",
          environmentVariables: { LOG_LEVEL: "debug" },
          tags: { env: "prod" },
        }),
      );
      expect(updated.tool.toolId).toEqual(tool.toolId);
      const reobserved = yield* getTool(group.resourceGroupName, tool.toolName);
      expect(reobserved.properties?.version).toEqual("1.1.0");
      expect(reobserved.properties?.environmentVariables?.LOG_LEVEL).toEqual(
        "debug",
      );
      expect(reobserved.tags?.env).toEqual("prod");

      // A location change replaces the tool.
      const replaced = yield* stack.deploy(
        program({
          location: "eastus2",
          version: "1.1.0",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.tool.location.toLowerCase()).toEqual("eastus2");
      expect(replaced.tool.toolName).not.toEqual(tool.toolName);
      expect(
        yield* waitGone(getTool(group.resourceGroupName, tool.toolName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getTool(group.resourceGroupName, replaced.tool.toolName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

test.provider(
  "discovery tools are rejected where the preview is not enabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(probeGroup);
      const subscriptionId = yield* subscription;
      const error = yield* discovery
        .ToolsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          toolName: "alchemy-probe",
          location,
          properties: {
            version: "1.0.0",
            definitionContent: { name: "probe" },
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("InvalidResourceType");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
