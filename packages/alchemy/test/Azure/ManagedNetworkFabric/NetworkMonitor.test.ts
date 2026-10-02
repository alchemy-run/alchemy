import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as mnf from "@distilled.cloud/azure/managednetworkfabric";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

type Props = Omit<
  Azure.ManagedNetworkFabric.NetworkMonitorProps,
  "resourceGroup"
>;

const program = (props: Props) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const res = yield* Azure.ManagedNetworkFabric.NetworkMonitor(
      "NetworkMonitor",
      {
        resourceGroup: group.resourceGroupName,
        ...props,
      },
    );
    return { group, res };
  });

const get = (resourceGroupName: string, networkMonitorName: string) =>
  Effect.gen(function* () {
    return yield* mnf.GetNetworkMonitor({
      subscriptionId: yield* subscription,
      resourceGroupName,
      networkMonitorName,
    });
  });

const CREATE: Props = {
  bmpConfiguration: {
    stationIp: "10.0.0.10",
    stationPort: 5000,
    stationConnectionMode: "Active",
    stationConnectionProperties: { probeInterval: 60, probeCount: 10 },
  },
  tags: { env: "a" },
};

const UPDATE: Props = {
  bmpConfiguration: {
    stationIp: "10.0.0.10",
    stationPort: 5001,
    stationConnectionMode: "Active",
    stationConnectionProperties: { probeInterval: 60, probeCount: 10 },
  },
  tags: { env: "b" },
};

// ARM configuration object only (no fabric attached): $0, ~1-3 minutes.
test.provider(
  "create, update, replace, and delete a network monitor",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, res } = yield* stack.deploy(program(CREATE));
      const observed = yield* get(
        group.resourceGroupName,
        res.networkMonitorName,
      );
      expect(observed.properties.bmpConfiguration?.stationPort).toEqual(5000);
      expect(observed.tags?.env).toEqual("a");
      expect(observed.tags?.["alchemy::id"]).toEqual("NetworkMonitor");
      expect(res.provisioningState).toEqual("Succeeded");

      // In place.
      const updated = yield* stack.deploy(program(UPDATE));
      expect(updated.res.networkMonitorId).toEqual(res.networkMonitorId);
      const reobserved = yield* get(
        group.resourceGroupName,
        res.networkMonitorName,
      );
      expect(reobserved.properties.bmpConfiguration?.stationPort).toEqual(5001);
      expect(reobserved.tags?.env).toEqual("b");

      // Replacement.
      const replaced = yield* stack.deploy(
        program({ ...UPDATE, location: "westus3" }),
      );
      expect(replaced.res.networkMonitorId).not.toEqual(res.networkMonitorId);
      expect(replaced.res.location).toEqual("westus3");
      expect(
        yield* waitGone(get(group.resourceGroupName, res.networkMonitorName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          get(group.resourceGroupName, replaced.res.networkMonitorName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
