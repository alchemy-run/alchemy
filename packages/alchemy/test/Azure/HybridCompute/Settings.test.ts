import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hybridcompute from "@distilled.cloud/azure/hybridcompute";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import {
  fixturePublicKey,
  fixtureVmId,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSettings = (resourceGroupName: string, machineName: string) =>
  Effect.gen(function* () {
    return yield* hybridcompute.GetSettings({
      subscriptionId: yield* subscription,
      resourceGroupName,
      baseProvider: "Microsoft.HybridCompute",
      baseResourceType: "machines",
      baseResourceName: machineName,
      settingsResourceName: "default",
    });
  });

const getMachine = (resourceGroupName: string, machineName: string) =>
  Effect.gen(function* () {
    return yield* hybridcompute.GetMachine({
      subscriptionId: yield* subscription,
      resourceGroupName,
      machineName,
    });
  });

const program = (props: { withGateway: boolean; associate: boolean }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const machine = yield* Azure.HybridCompute.Machine("Machine", {
      resourceGroup: group.resourceGroupName,
      vmId: fixtureVmId,
      clientPublicKey: fixturePublicKey,
      osType: "linux",
    });
    const gateway = props.withGateway
      ? yield* Azure.HybridCompute.Gateway("Gateway", {
          resourceGroup: group.resourceGroupName,
        })
      : undefined;
    const settings = yield* Azure.HybridCompute.Settings("Settings", {
      resourceGroup: group.resourceGroupName,
      machineName: machine.machineName,
      gatewayResourceId: props.associate
        ? gateway?.gatewayResourceId
        : undefined,
    });
    return { group, machine, gateway, settings };
  });

// Free (an unconnected machine record), seconds.
test.provider(
  "declare and destroy the settings of an Arc machine",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, machine, settings } = yield* stack.deploy(
        program({ withGateway: false, associate: false }),
      );
      const rg = group.resourceGroupName;
      expect(settings.settingsId.toLowerCase()).toContain(
        `/machines/${machine.machineName.toLowerCase()}/providers/microsoft.hybridcompute/settings/default`,
      );
      expect(settings.gatewayResourceId).toBeUndefined();
      const observed = yield* getSettings(rg, machine.machineName);
      expect(
        observed.properties?.gatewayProperties?.gatewayResourceId || undefined,
      ).toBeUndefined();

      // A redeploy with nothing changed is a no-op.
      const again = yield* stack.deploy(
        program({ withGateway: false, associate: false }),
      );
      expect(again.settings.settingsId).toEqual(settings.settingsId);

      yield* stack.destroy();
      expect(yield* waitGone(getMachine(rg, machine.machineName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);

// Needs an Arc gateway, which took ~24 minutes to provision.
test.provider.skipIf(!runExpensive)(
  "associate and dissociate an Arc gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, machine, gateway } = yield* stack.deploy(
        program({ withGateway: true, associate: true }),
      );
      const rg = group.resourceGroupName;
      const observed = yield* getSettings(rg, machine.machineName);
      expect(
        observed.properties?.gatewayProperties?.gatewayResourceId?.toLowerCase(),
      ).toEqual(gateway?.gatewayResourceId.toLowerCase());

      // In-place: dissociate (the gateway stays deployed).
      const updated = yield* stack.deploy(
        program({ withGateway: true, associate: false }),
      );
      expect(updated.settings.gatewayResourceId).toBeUndefined();
      const reobserved = yield* getSettings(rg, machine.machineName);
      expect(
        reobserved.properties?.gatewayProperties?.gatewayResourceId ||
          undefined,
      ).toBeUndefined();

      // Re-associate, then destroy clears the association.
      yield* stack.deploy(program({ withGateway: true, associate: true }));
      yield* stack.destroy();
      expect(yield* waitGone(getMachine(rg, machine.machineName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 3_000_000 },
);
