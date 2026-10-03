import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hybridcompute from "@distilled.cloud/azure/hybridcompute";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  fixturePublicKey,
  fixtureVmId,
  fixtureVmId2,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getMachine = (resourceGroupName: string, machineName: string) =>
  Effect.gen(function* () {
    return yield* hybridcompute.GetMachine({
      subscriptionId: yield* subscription,
      resourceGroupName,
      machineName,
    });
  });

const program = (props: {
  vmId: string;
  scoped?: boolean;
  locationData?: Azure.HybridCompute.MachineLocationData;
  tags?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const scope = yield* Azure.HybridCompute.PrivateLinkScope("Scope", {
      resourceGroup: group.resourceGroupName,
      publicNetworkAccess: "Enabled",
    });
    // Pre-registered without an agent: the record waits in
    // AwaitingConnection.
    const machine = yield* Azure.HybridCompute.Machine("Machine", {
      resourceGroup: group.resourceGroupName,
      vmId: props.vmId,
      clientPublicKey: fixturePublicKey,
      osType: "linux",
      privateLinkScopeResourceId: props.scoped
        ? scope.privateLinkScopeResourceId
        : undefined,
      locationData: props.locationData,
      tags: props.tags,
    });
    return { group, scope, machine };
  });

// Free (an unconnected machine record), seconds.
test.provider(
  "create, update, replace, and delete an Arc machine",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, machine } = yield* stack.deploy(
        program({ vmId: fixtureVmId }),
      );
      const rg = group.resourceGroupName;
      expect(machine.status).toEqual("AwaitingConnection");
      expect(machine.vmId).toEqual(fixtureVmId);
      expect(machine.principalId).toMatch(/^[0-9a-f-]{36}$/);
      const observed = yield* getMachine(rg, machine.machineName);
      expect(observed.properties?.vmId).toEqual(fixtureVmId);
      expect(observed.tags?.["alchemy::id"]).toEqual("Machine");

      // In-place: private link scope, location data, and a tag.
      const updated = yield* stack.deploy(
        program({
          vmId: fixtureVmId,
          scoped: true,
          locationData: { name: "Seattle", city: "Seattle" },
          tags: { env: "test" },
        }),
      );
      expect(updated.machine.machineId).toEqual(machine.machineId);
      const reobserved = yield* getMachine(rg, machine.machineName);
      expect(
        reobserved.properties?.privateLinkScopeResourceId?.toLowerCase(),
      ).toEqual(updated.scope.privateLinkScopeResourceId.toLowerCase());
      expect(reobserved.properties?.locationData?.name).toEqual("Seattle");
      expect(reobserved.tags?.env).toEqual("test");

      // Replacement: the host identity is immutable.
      const replaced = yield* stack.deploy(
        program({
          vmId: fixtureVmId2,
          scoped: true,
          locationData: { name: "Seattle", city: "Seattle" },
          tags: { env: "test" },
        }),
      );
      expect(replaced.machine.machineName).not.toEqual(machine.machineName);
      const replacedObserved = yield* getMachine(
        rg,
        replaced.machine.machineName,
      );
      expect(replacedObserved.properties?.vmId).toEqual(fixtureVmId2);
      expect(yield* waitGone(getMachine(rg, machine.machineName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(getMachine(rg, replaced.machine.machineName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
