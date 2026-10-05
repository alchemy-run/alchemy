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

const getConfig = (resourceGroupName: string, environmentName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* app.GetMaintenanceConfiguration({
      subscriptionId,
      resourceGroupName,
      environmentName,
      configName: "default",
    });
  });

const program = (props?: {
  weekDay: "Sunday" | "Saturday";
  startHourUtc: number;
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
    if (props === undefined) return { group, env, maintenance: undefined };
    const maintenance = yield* Azure.ContainerApps.MaintenanceConfiguration(
      "Maintenance",
      {
        resourceGroup: group.resourceGroupName,
        environment: env.environmentName,
        scheduledEntries: [
          {
            weekDay: props.weekDay,
            startHourUtc: props.startHourUtc,
            durationHours: 8,
          },
        ],
      },
    );
    return { group, env, maintenance };
  });

// Cost: Consumption environment (free idle); planned maintenance is free
// (~$0). Gated (time, not cost): the trial allows one standard environment
// per subscription, so these lifecycles serialize behind
// `withStandardEnvironment`, and an environment delete takes 5-25 minutes
// (~15-35 minutes per test). Run with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a maintenance configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, env, maintenance } = yield* stack.deploy(
        program({ weekDay: "Sunday", startHourUtc: 1 }),
      );
      if (maintenance === undefined) return yield* Effect.die("no config");
      expect(maintenance.configName).toEqual("default");
      expect(maintenance.scheduledEntries).toEqual([
        { weekDay: "Sunday", startHourUtc: 1, durationHours: 8 },
      ]);
      const observed = yield* getConfig(
        group.resourceGroupName,
        env.environmentName,
      );
      expect(observed.properties?.scheduledEntries?.[0]?.weekDay).toEqual(
        "Sunday",
      );

      // In-place update: move the window.
      const updated = yield* stack.deploy(
        program({ weekDay: "Saturday", startHourUtc: 22 }),
      );
      expect(updated.maintenance?.configId).toEqual(maintenance.configId);
      const reobserved = yield* getConfig(
        group.resourceGroupName,
        env.environmentName,
      );
      expect(reobserved.properties?.scheduledEntries?.[0]).toMatchObject({
        weekDay: "Saturday",
        startHourUtc: 22,
      });

      // Delete the configuration while its environment stays.
      yield* stack.deploy(program());
      expect(
        yield* waitGone(
          getConfig(group.resourceGroupName, env.environmentName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(withStandardEnvironment, logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerapps", "live"],
    timeout: 3_600_000,
  },
);
