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
    return yield* app.GetDotNetComponent({
      subscriptionId,
      resourceGroupName,
      environmentName,
      name,
    });
  });

const program = (props?: { name: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const env = yield* Azure.ContainerApps.ManagedEnvironment("Env", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      workloadProfiles: CONSUMPTION_PROFILES,
    });
    if (props === undefined) return { group, env, dashboard: undefined };
    const dashboard = yield* Azure.ContainerApps.DotNetComponent("Aspire", {
      resourceGroup: group.resourceGroupName,
      environment: env.environmentName,
      name: props.name,
      componentType: "AspireDashboard",
    });
    return { group, env, dashboard };
  });

// Cost: Consumption environment (free idle) + the Aspire dashboard running
// for ~15 minutes on Consumption (~$0.05). Gated (time, not cost): the
// trial allows one standard environment per subscription, so these
// lifecycles serialize behind `withStandardEnvironment`, and an environment
// delete takes 5-25 minutes (~15-35 minutes per test). Run with
// AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, replace, and delete a .NET component",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, env, dashboard } = yield* stack.deploy(
        program({ name: "aspire-dashboard" }),
      );
      if (dashboard === undefined) return yield* Effect.die("no dashboard");
      expect(dashboard.componentName).toEqual("aspire-dashboard");
      expect(dashboard.componentType).toEqual("AspireDashboard");
      const observed = yield* getComponent(
        group.resourceGroupName,
        env.environmentName,
        dashboard.componentName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");

      // Replacement: a new name recreates the component.
      const replaced = yield* stack.deploy(program({ name: "aspire-two" }));
      expect(replaced.dashboard?.componentName).toEqual("aspire-two");
      expect(
        (yield* getComponent(
          group.resourceGroupName,
          env.environmentName,
          "aspire-two",
        )).properties?.componentType,
      ).toEqual("AspireDashboard");
      expect(
        yield* waitGone(
          getComponent(
            group.resourceGroupName,
            env.environmentName,
            "aspire-dashboard",
          ),
        ),
      ).toEqual("gone");

      // Delete the component while its environment stays.
      yield* stack.deploy(program());
      expect(
        yield* waitGone(
          getComponent(
            group.resourceGroupName,
            env.environmentName,
            "aspire-two",
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(withStandardEnvironment, logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerapps", "live"],
    timeout: 3_600_000,
  },
);
