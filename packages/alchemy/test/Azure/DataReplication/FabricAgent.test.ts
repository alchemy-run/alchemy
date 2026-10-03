import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as dr from "@distilled.cloud/azure/recoveryservicesdatareplication";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { LOCATION, logLevel, subscription, tags, waitGone } from "./shared.ts";

const { test } = Test.make({ providers: Azure.providers() });

/**
 * An agent registers a real VMware appliance with a VMware fabric:
 * `AZURE_DR_VMWARE_SITE_ID`, `AZURE_DR_MIGRATION_SOLUTION_ID`, the
 * appliance's `AZURE_DR_AGENT_MACHINE_ID` / `AZURE_DR_AGENT_MACHINE_NAME` /
 * `AZURE_DR_AGENT_BIOS_ID`, and the appliance service principal
 * (`AZURE_DR_AGENT_APP_ID`, `AZURE_DR_AGENT_OBJECT_ID`).
 */
const env = (name: string) => process.env[name] ?? "";

const identity = () => {
  const tenantId = env("AZURE_TENANT_ID");
  const applicationId = env("AZURE_DR_AGENT_APP_ID");
  return {
    tenantId,
    applicationId,
    objectId: env("AZURE_DR_AGENT_OBJECT_ID"),
    audience: `api://${applicationId}`,
    aadAuthority: `https://login.microsoftonline.com/${tenantId}`,
  };
};

const program = (machineName: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const fabric = yield* Azure.DataReplication.Fabric("Fabric", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      customProperties: {
        instanceType: "VMwareMigrate",
        vmwareSiteId: env("AZURE_DR_VMWARE_SITE_ID"),
        migrationSolutionId: env("AZURE_DR_MIGRATION_SOLUTION_ID"),
      },
    });
    const agent = yield* Azure.DataReplication.FabricAgent("Agent", {
      resourceGroup: group.resourceGroupName,
      fabric: fabric.fabricName,
      machineId: env("AZURE_DR_AGENT_MACHINE_ID"),
      machineName,
      authenticationIdentity: identity(),
      resourceAccessIdentity: identity(),
      customProperties: {
        instanceType: "VMware",
        biosId: env("AZURE_DR_AGENT_BIOS_ID"),
        marsAuthenticationIdentity: identity(),
      },
    });
    return { group, fabric, agent };
  });

const getAgent = (rg: string, fabricName: string, fabricAgentName: string) =>
  Effect.gen(function* () {
    return yield* dr.GetFabricAgent({
      subscriptionId: yield* subscription,
      resourceGroupName: rg,
      fabricName,
      fabricAgentName,
    });
  });

// Needs an on-premises VMware Azure Migrate appliance, which the test
// subscription does not have. Run with AZURE_TEST_PAID=1 plus the env
// vars above.
test.provider.skipIf(!runPaidOnly)(
  "register, replace, and delete a data replication fabric agent",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const machineName = env("AZURE_DR_AGENT_MACHINE_NAME");
      const { group, fabric, agent } = yield* stack.deploy(
        program(machineName),
      );
      const rg = group.resourceGroupName;
      const observed = yield* getAgent(
        rg,
        fabric.fabricName,
        agent.fabricAgentName,
      );
      expect(observed.properties?.machineName).toEqual(machineName);

      // Replace: every agent setting is immutable.
      const replaced = yield* stack.deploy(program(`${machineName}-renamed`));
      expect(replaced.agent.fabricAgentName).not.toEqual(agent.fabricAgentName);
      expect(
        yield* waitGone(getAgent(rg, fabric.fabricName, agent.fabricAgentName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getAgent(rg, fabric.fabricName, replaced.agent.fabricAgentName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, seconds): an agent can only be registered under an
// existing fabric; without one the PUT fails with ResourceNotFound.
test.provider(
  "probe: a fabric agent requires an existing fabric",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            const group = yield* Azure.Resources.ResourceGroup("Group", {
              location: LOCATION,
            });
            const zero = "00000000-0000-0000-0000-000000000000";
            const probeIdentity = {
              tenantId: zero,
              applicationId: zero,
              objectId: zero,
              audience: `api://${zero}`,
              aadAuthority: "https://login.microsoftonline.com/common",
            };
            const agent = yield* Azure.DataReplication.FabricAgent("Agent", {
              resourceGroup: group.resourceGroupName,
              fabric: "nofabric",
              machineId: zero,
              machineName: "probe",
              authenticationIdentity: probeIdentity,
              resourceAccessIdentity: probeIdentity,
              customProperties: { instanceType: "VMware" },
            });
            return { group, agent };
          }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toEqual("ResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
