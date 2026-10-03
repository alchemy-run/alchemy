import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as app from "@distilled.cloud/azure/app";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  CONSUMPTION_PROFILES,
  logLevel,
  STANDARD_LOCATION,
  waitGone,
  withStandardEnvironment,
} from "./fixtures/shared.ts";
import { runExpensive } from "../gates.ts";

const LOCATION = STANDARD_LOCATION;

const { test } = Test.make({ providers: Azure.providers() });

const getComponent = (
  resourceGroupName: string,
  environmentName: string,
  name: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* app.GetJavaComponent({
      subscriptionId,
      resourceGroupName,
      environmentName,
      name,
    });
  });

const program = (props?: { selfPreservation: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const env = yield* Azure.ContainerApps.ManagedEnvironment("Env", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      workloadProfiles: CONSUMPTION_PROFILES,
    });
    if (props === undefined) return { group, env, eureka: undefined };
    const eureka = yield* Azure.ContainerApps.JavaComponent("Eureka", {
      resourceGroup: group.resourceGroupName,
      environment: env.environmentName,
      componentType: "SpringCloudEureka",
      configurations: [
        {
          propertyName: "eureka.server.enable-self-preservation",
          value: props.selfPreservation,
        },
      ],
    });
    return { group, env, eureka };
  });

const selfPreservation = (observed: app.GetJavaComponentResponse) =>
  observed.properties?.configurations?.find(
    (c) => c.propertyName === "eureka.server.enable-self-preservation",
  )?.value;

// Cost: Consumption environment (free idle) + a Eureka server (1 replica)
// running for ~15 minutes on Consumption (~$0.05). Gated (time, not cost):
// the trial allows one standard environment per subscription, so these
// lifecycles serialize behind `withStandardEnvironment`, and an environment
// delete takes 5-25 minutes (~15-35 minutes per test). Run with
// AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a Java component",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, env, eureka } = yield* stack.deploy(
        program({ selfPreservation: "false" }),
      );
      if (eureka === undefined) return yield* Effect.die("no component");
      expect(eureka.componentType).toEqual("SpringCloudEureka");
      const get = getComponent(
        group.resourceGroupName,
        env.environmentName,
        eureka.componentName,
      );
      const observed = yield* get;
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(selfPreservation(observed)).toEqual("false");

      // In-place update: change a configuration property.
      const updated = yield* stack.deploy(
        program({ selfPreservation: "true" }),
      );
      expect(updated.eureka?.componentId).toEqual(eureka.componentId);
      expect(selfPreservation(yield* get)).toEqual("true");

      // Delete the component while its environment stays.
      yield* stack.deploy(program());
      expect(yield* waitGone(get)).toEqual("gone");

      yield* stack.destroy();
    }).pipe(withStandardEnvironment, logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerapps", "live"],
    timeout: 3_600_000,
  },
);
