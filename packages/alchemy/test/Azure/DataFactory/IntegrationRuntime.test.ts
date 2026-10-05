import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as datafactory from "@distilled.cloud/azure/datafactory";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getRuntime = (
  resourceGroupName: string,
  factoryName: string,
  integrationRuntimeName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* datafactory.GetIntegrationRuntime({
      subscriptionId,
      resourceGroupName,
      factoryName,
      integrationRuntimeName,
    });
  });

const runtimeGone = (
  resourceGroupName: string,
  factoryName: string,
  integrationRuntimeName: string,
) =>
  getRuntime(resourceGroupName, factoryName, integrationRuntimeName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const program = (props: { timeToLive: number; description: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("RuntimeGroup", {
      location: "eastus",
    });
    const factory = yield* Azure.DataFactory.Factory("RuntimeFactory", {
      resourceGroup: group.resourceGroupName,
    });
    const managed = yield* Azure.DataFactory.IntegrationRuntime("Flows", {
      resourceGroup: group.resourceGroupName,
      factoryName: factory.factoryName,
      type: "Managed",
      typeProperties: {
        computeProperties: {
          location: "AutoResolve",
          dataFlowProperties: {
            computeType: "General",
            coreCount: 8,
            timeToLive: props.timeToLive,
          },
        },
      },
      description: props.description,
    });
    const selfHosted = yield* Azure.DataFactory.IntegrationRuntime("OnPrem", {
      resourceGroup: group.resourceGroupName,
      factoryName: factory.factoryName,
      type: "SelfHosted",
    });
    return { group, factory, managed, selfHosted };
  });

// ~$0: an Azure IR bills only while a data flow runs, and a self-hosted IR
// with no registered node bills nothing. ~1-2 minutes.
test.provider(
  "create, update, and delete managed and self-hosted integration runtimes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, factory, managed, selfHosted } = yield* stack.deploy(
        program({ timeToLive: 10, description: "data flows" }),
      );
      expect(managed.integrationRuntimeName).toMatch(
        /^[a-z0-9]+(-[a-z0-9]+)*$/,
      );
      expect(managed.type).toEqual("Managed");
      expect(managed.description).toEqual("data flows");
      expect(managed.authKey1).toBeUndefined();
      const observed = yield* getRuntime(
        group.resourceGroupName,
        factory.factoryName,
        managed.integrationRuntimeName,
      );
      expect(observed.properties.description).toMatch(
        /^data flows \[alchemy .+\/Flows\]$/,
      );
      expect(observed.properties.typeProperties).toMatchObject({
        computeProperties: {
          location: "AutoResolve",
          dataFlowProperties: { timeToLive: 10 },
        },
      });

      expect(selfHosted.type).toEqual("SelfHosted");
      expect(selfHosted.state).toEqual("NeedRegistration");
      expect(selfHosted.authKey1).toBeDefined();
      expect(Redacted.value(selfHosted.authKey1!)).toMatch(/^IR@/);

      // In place: data flow time-to-live and description.
      const updated = yield* stack.deploy(
        program({ timeToLive: 20, description: "data flows v2" }),
      );
      expect(updated.managed.integrationRuntimeName).toEqual(
        managed.integrationRuntimeName,
      );
      const reobserved = yield* getRuntime(
        group.resourceGroupName,
        factory.factoryName,
        managed.integrationRuntimeName,
      );
      expect(reobserved.properties.typeProperties).toMatchObject({
        computeProperties: { dataFlowProperties: { timeToLive: 20 } },
      });
      expect(reobserved.properties.description).toMatch(/^data flows v2 /);

      yield* stack.destroy();
      expect(
        yield* runtimeGone(
          group.resourceGroupName,
          factory.factoryName,
          managed.integrationRuntimeName,
        ),
      ).toEqual("gone");
      expect(
        yield* runtimeGone(
          group.resourceGroupName,
          factory.factoryName,
          selfHosted.integrationRuntimeName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:datafactory", "live"],
    timeout: 600_000,
  },
);
