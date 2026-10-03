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
  componentName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* app.GetDaprComponent({
      subscriptionId,
      resourceGroupName,
      environmentName,
      componentName,
    });
  });

const program = (props: {
  componentType: string;
  schedule: string;
  scopes: string[];
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const env = yield* Azure.ContainerApps.ManagedEnvironment("Env", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      workloadProfiles: CONSUMPTION_PROFILES,
    });
    const component = yield* Azure.ContainerApps.DaprComponent("Cron", {
      resourceGroup: group.resourceGroupName,
      environment: env.environmentName,
      componentType: props.componentType,
      metadata: [{ name: "schedule", value: props.schedule }],
      scopes: props.scopes,
    });
    return { group, env, component };
  });

// Cost: Consumption environment (free idle); Dapr components are free (~$0).
// Gated (time, not cost): the trial allows one standard environment per
// subscription, so these lifecycles serialize behind
// `withStandardEnvironment`, and an environment delete takes 5-25 minutes
// (~15-35 minutes per test). Run with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete a dapr component",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, env, component } = yield* stack.deploy(
        program({
          componentType: "bindings.cron",
          schedule: "@every 10m",
          scopes: ["worker"],
        }),
      );
      expect(component.componentType).toEqual("bindings.cron");
      expect(component.scopes).toEqual(["worker"]);

      const observed = yield* getComponent(
        group.resourceGroupName,
        env.environmentName,
        component.componentName,
      );
      expect(observed.properties?.version).toEqual("v1");
      expect(observed.properties?.metadata?.[0]?.value).toEqual("@every 10m");

      // In-place update: metadata and scopes.
      const updated = yield* stack.deploy(
        program({
          componentType: "bindings.cron",
          schedule: "@every 20m",
          scopes: ["worker", "api"],
        }),
      );
      expect(updated.component.componentId).toEqual(component.componentId);
      const reobserved = yield* getComponent(
        group.resourceGroupName,
        env.environmentName,
        component.componentName,
      );
      expect(reobserved.properties?.metadata?.[0]?.value).toEqual("@every 20m");
      expect(reobserved.properties?.scopes).toEqual(["worker", "api"]);

      // Replacement: a new component type recreates the component.
      const replaced = yield* stack.deploy(
        program({
          componentType: "state.in-memory",
          schedule: "@every 20m",
          scopes: ["worker"],
        }),
      );
      expect(replaced.component.componentType).toEqual("state.in-memory");
      const recreated = yield* getComponent(
        group.resourceGroupName,
        env.environmentName,
        replaced.component.componentName,
      );
      expect(recreated.properties?.componentType).toEqual("state.in-memory");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getComponent(
            group.resourceGroupName,
            env.environmentName,
            replaced.component.componentName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(withStandardEnvironment, logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerapps", "live"],
    timeout: 3_600_000,
  },
);
