import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as devcenter from "@distilled.cloud/azure/devcenter";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPool = (
  resourceGroupName: string,
  projectName: string,
  poolName: string,
) =>
  Effect.gen(function* () {
    return yield* devcenter.GetPool({
      subscriptionId: yield* subscription,
      resourceGroupName,
      projectName,
      poolName,
    });
  });

const program = (props: {
  name?: string;
  displayName: string;
  tags: Record<string, string>;
}) =>
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
      name: props.name,
      location: "eastus",
      devBoxDefinitionName: definition.devBoxDefinitionName,
      displayName: props.displayName,
      tags: props.tags,
    });
    return { group, project, definition, pool };
  });

// Ungated: the trial tenant was never onboarded to Dev Box, which stopped
// accepting new customers on 2025-11-01, so pools and their definitions are
// rejected with a typed error. ~7 minutes (dev center create + delete), $0.
test.provider(
  "dev box pool creation is rejected for tenants not onboarded to Dev Box",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group, center, project } = yield* stack.deploy(
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
          return { group, center, project };
        }),
      );
      const subscriptionId = yield* subscription;
      const definition = yield* devcenter
        .DevBoxDefinitionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          devCenterName: center.devCenterName,
          devBoxDefinitionName: "alchemy-probe",
          location: "eastus",
          properties: {
            imageReference: {
              id: `${center.devCenterId}/galleries/default/images/microsoftwindowsdesktop_windows-ent-cpc_win11-24h2-ent-cpc`,
            },
            sku: { name: "general_i_8c32gb256ssd_v2" },
          },
        })
        .pipe(Effect.flip);
      expect(definition._tag).toEqual("DevBoxTenantNotOnboarded");
      const pool = yield* devcenter
        .PoolsCreateOrUpdate({
          subscriptionId,
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
// Dev centers, projects, definitions, and pools are free (no dev boxes are
// created); ~6-10 minutes in total, $0.
// Skipped: failed in the last live run. DevBoxTenantNotOnboarded: As of November 1st 2025,
// Microsoft Dev Box has stopped accepting new customers. The tenant for the provided subscription
// is not authorized to create Dev Box specific resources. Learn more about
test.provider.skip(
  "create, update, replace, and delete a dev box pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, project, definition, pool } = yield* stack.deploy(
        program({ displayName: "One", tags: { a: "1" } }),
      );
      expect(pool.networkConnectionName).toEqual("managedNetwork");
      const observed = yield* getPool(
        group.resourceGroupName,
        project.projectName,
        pool.poolName,
      );
      expect(observed.properties?.devBoxDefinitionName).toEqual(
        definition.devBoxDefinitionName,
      );
      expect(observed.properties?.virtualNetworkType).toEqual("Managed");
      expect(observed.properties?.displayName).toEqual("One");
      expect(observed.tags?.a).toEqual("1");
      expect(observed.tags?.["alchemy::id"]).toEqual("Pool");

      // In place: display name and tags.
      const updated = yield* stack.deploy(
        program({ displayName: "Two", tags: { a: "2" } }),
      );
      expect(updated.pool.poolId).toEqual(pool.poolId);
      const reobserved = yield* getPool(
        group.resourceGroupName,
        project.projectName,
        pool.poolName,
      );
      expect(reobserved.properties?.displayName).toEqual("Two");
      expect(reobserved.tags?.a).toEqual("2");

      // Replacement: the name is immutable.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-pool-renamed",
          displayName: "Two",
          tags: { a: "2" },
        }),
      );
      expect(replaced.pool.poolName).toEqual("alchemy-pool-renamed");
      expect(
        yield* waitGone(
          getPool(group.resourceGroupName, project.projectName, pool.poolName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getPool(
            group.resourceGroupName,
            project.projectName,
            replaced.pool.poolName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
