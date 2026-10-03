import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as devcenter from "@distilled.cloud/azure/devcenter";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSchedule = (
  resourceGroupName: string,
  projectName: string,
  poolName: string,
) =>
  Effect.gen(function* () {
    return yield* devcenter.GetSchedule({
      subscriptionId: yield* subscription,
      resourceGroupName,
      projectName,
      poolName,
      scheduleName: "default",
    });
  });

const program = (props: { time: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const center = yield* Azure.DevCenter.DevCenter("Center", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      microsoftHostedNetworkEnableStatus: "Enabled",
    });
    const project = yield* Azure.DevCenter.Project("Project", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      devCenterId: center.devCenterId,
    });
    const definition = yield* Azure.DevCenter.DevBoxDefinition("Definition", {
      resourceGroup: group.resourceGroupName,
      devCenter: center.devCenterName,
      location: "eastus",
      imageReferenceId: Output.interpolate`${center.devCenterId}/galleries/default/images/microsoftwindowsdesktop_windows-ent-cpc_win11-24h2-ent-cpc`,
      skuName: "general_i_8c32gb256ssd_v2",
      osStorageType: "ssd_256gb",
    });
    const pool = yield* Azure.DevCenter.Pool("Pool", {
      resourceGroup: group.resourceGroupName,
      project: project.projectName,
      location: "eastus",
      devBoxDefinitionName: definition.devBoxDefinitionName,
    });
    const schedule = yield* Azure.DevCenter.Schedule("Schedule", {
      resourceGroup: group.resourceGroupName,
      project: project.projectName,
      pool: pool.poolName,
      time: props.time,
      timeZone: "America/Los_Angeles",
      tags: props.tags,
    });
    return { group, project, pool, schedule };
  });

// Ungated: a schedule needs a pool, and the trial tenant was never
// onboarded to Dev Box (which stopped accepting new customers on
// 2025-11-01), so the pool is rejected with a typed error. ~7 minutes
// (dev center create + delete), $0.
test.provider(
  "dev box pool schedules are unavailable for tenants not onboarded to Dev Box",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group, project } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          const center = yield* Azure.DevCenter.DevCenter("Center", {
            resourceGroup: group.resourceGroupName,
            location: "eastus",
            microsoftHostedNetworkEnableStatus: "Enabled",
          });
          const project = yield* Azure.DevCenter.Project("Project", {
            resourceGroup: group.resourceGroupName,
            location: "eastus",
            devCenterId: center.devCenterId,
          });
          return { group, project };
        }),
      );
      const pool = yield* devcenter
        .PoolsCreateOrUpdate({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          projectName: project.projectName,
          poolName: "alchemy-probe",
          location: "eastus",
          properties: {
            devBoxDefinitionName: "alchemy-probe",
            networkConnectionName: "managedNetwork",
            virtualNetworkType: "Managed",
            managedVirtualNetworkRegions: ["eastus"],
            licenseType: "Windows_Client",
            localAdministrator: "Enabled",
          },
        })
        .pipe(Effect.flip);
      expect(pool._tag).toEqual("DevBoxTenantNotOnboarded");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Gated: needs a tenant onboarded to Dev Box (see the probe above).
// Everything here is free (no dev boxes are created); ~6-10 minutes, $0.
// Schedules accept only the name `default` and type `StopDevBox`, so there
// is no replacement step.
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete a dev box pool schedule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, project, pool, schedule } = yield* stack.deploy(
        program({ time: "19:00", tags: { a: "1" } }),
      );
      expect(schedule.scheduleName).toEqual("default");
      const observed = yield* getSchedule(
        group.resourceGroupName,
        project.projectName,
        pool.poolName,
      );
      expect(observed.properties?.type).toEqual("StopDevBox");
      expect(observed.properties?.time).toEqual("19:00");
      expect(observed.properties?.timeZone).toEqual("America/Los_Angeles");
      expect(observed.properties?.tags?.a).toEqual("1");
      expect(observed.properties?.tags?.["alchemy::id"]).toEqual("Schedule");

      // In place: time and tags.
      const updated = yield* stack.deploy(
        program({ time: "20:00", tags: { a: "2" } }),
      );
      expect(updated.schedule.scheduleId).toEqual(schedule.scheduleId);
      const reobserved = yield* getSchedule(
        group.resourceGroupName,
        project.projectName,
        pool.poolName,
      );
      expect(reobserved.properties?.time).toEqual("20:00");
      expect(reobserved.properties?.tags?.a).toEqual("2");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getSchedule(
            group.resourceGroupName,
            project.projectName,
            pool.poolName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
