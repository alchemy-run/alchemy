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

const getScript = (resourceGroupName: string, scriptName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* orUndefinedIfNotFound(
      resources.GetDeploymentScript({
        subscriptionId,
        resourceGroupName,
        scriptName,
      }),
    );
  });

const scriptGone = (resourceGroupName: string, scriptName: string) =>
  getScript(resourceGroupName, scriptName).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (observed) => observed === undefined,
      times: 24,
    }),
  );

const program = (props: {
  greeting: string;
  forceUpdateTag: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const script = yield* Azure.Resources.DeploymentScript("Script", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      kind: "AzureCLI",
      environmentVariables: { NAME: "world" },
      scriptContent: `echo "{\\"greeting\\": \\"${props.greeting} $NAME\\", \\"run\\": \\"$RANDOM\\"}" > $AZ_SCRIPTS_OUTPUT_PATH`,
      forceUpdateTag: props.forceUpdateTag,
      tags: props.tags,
    });
    return { group, script };
  });

// Each run provisions a short-lived container instance + storage account
// (cleanupPreference Always): ~1-2 min and well under $0.05 per run.
test.provider(
  "run a deployment script, sync tags, re-run on forceUpdateTag, replace on new content, and delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, script } = yield* stack.deploy(
        program({ greeting: "hello", forceUpdateTag: "1", tags: { a: "1" } }),
      );
      expect(script.provisioningState).toEqual("Succeeded");
      expect(script.outputs.greeting).toEqual("hello world");
      expect(script.kind).toEqual("AzureCLI");
      expect(script.tags).toEqual({ a: "1" });
      const observed = yield* getScript(
        group.resourceGroupName,
        script.deploymentScriptName,
      );
      expect(observed?.tags?.["alchemy::id"]).toEqual("Script");
      expect(observed?.properties?.retentionInterval).toBeDefined();

      // A tag change is a PATCH: the script does not re-run.
      const retagged = yield* stack.deploy(
        program({ greeting: "hello", forceUpdateTag: "1", tags: { a: "2" } }),
      );
      expect(retagged.script.tags).toEqual({ a: "2" });
      expect(retagged.script.outputs.run).toEqual(script.outputs.run);

      // A new forceUpdateTag re-runs the script in place.
      const rerun = yield* stack.deploy(
        program({ greeting: "hello", forceUpdateTag: "2", tags: { a: "2" } }),
      );
      expect(rerun.script.deploymentScriptName).toEqual(
        script.deploymentScriptName,
      );
      expect(rerun.script.forceUpdateTag).toEqual("2");
      expect(rerun.script.outputs.greeting).toEqual("hello world");

      // New script content replaces the script.
      const replaced = yield* stack.deploy(
        program({ greeting: "hi", forceUpdateTag: "2", tags: { a: "2" } }),
      );
      expect(replaced.script.deploymentScriptName).not.toEqual(
        script.deploymentScriptName,
      );
      expect(replaced.script.outputs.greeting).toEqual("hi world");
      expect(
        yield* scriptGone(group.resourceGroupName, script.deploymentScriptName),
      ).toBeUndefined();

      yield* stack.destroy();
      expect(
        yield* scriptGone(
          group.resourceGroupName,
          replaced.script.deploymentScriptName,
        ),
      ).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:resources", "live"],
    timeout: 900_000,
  },
);
