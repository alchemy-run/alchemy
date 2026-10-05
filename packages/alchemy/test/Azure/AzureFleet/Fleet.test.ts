import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as azurefleet from "@distilled.cloud/azure/azurefleet";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { withVcpus } from "../gates.ts";
import { ensureQuota } from "../quota.ts";

const { test } = Test.make({ providers: Azure.providers() });

const tags = ["provider:azure", "provider:azure:azurefleet", "live"];

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/**
 * Compute Fleet runs its own capacity check, stricter than plain VMs/scale
 * sets: on this subscription it rejects every size tried in eastus, eastus2,
 * westus2, westus3, centralus and northeurope with `SkuNotAvailable`, but
 * accepts the 1-vCPU F-series v7 sizes in swedencentral.
 */
const LOCATION = process.env.AZURE_TEST_VM_LOCATION ?? "swedencentral";
const SIZE = process.env.AZURE_TEST_VM_SIZE ?? "Standard_F1als_v7";
const SIZE_ALT = process.env.AZURE_TEST_VM_SIZE_ALT ?? "Standard_F1as_v7";

/** Checked-in OpenSSH public key (private half discarded). */
const PUBLIC_KEY =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDENxJhC8/syZZ882HXvsvtHroY2qgTIi0Pbxn3I8ypeeKuerxliUK1Ht9xFcz2phTMNwoHzDcS5hdHT6GiYX+kxhbrrWA/b7D1MoqRu0WlIhB/vocs4WU06nWGQi0UXKWfVyfIHGZKgnw9vTcIutmW8KbQySIzgCYtYMD6a9PLL61O0LJaDcH5XDXEeygGLN9yVWitUJy0RNCZmS4qHB3QYzrXisDD0lzxRleIlp4KDpWvriuI8Chswe5rQ6RAEZXpEXYQfEwXm7jO7yO7ZSACh22am2suq4TRcTKlEFPw0V8ksCNzstQdbGsCStfB396XqmPEvz2IqSzMDljGodF/ alchemy-test-1";

const subscriptionId = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

const getFleet = (resourceGroupName: string, fleetName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    azurefleet.GetFleet({ subscriptionId, resourceGroupName, fleetName }),
  );

const untilGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times: 30,
    }),
  );

const computeProfile = (
  subnetId: string,
  computerNamePrefix: string,
): Azure.AzureFleet.FleetComputeProfile => ({
  baseVirtualMachineProfile: {
    storageProfile: {
      imageReference: {
        publisher: "Canonical",
        offer: "ubuntu-24_04-lts",
        sku: "server",
        version: "latest",
      },
      osDisk: {
        createOption: "FromImage",
        managedDisk: { storageAccountType: "Standard_LRS" },
        deleteOption: "Delete",
      },
    },
    osProfile: {
      computerNamePrefix,
      adminUsername: "azureuser",
      linuxConfiguration: {
        disablePasswordAuthentication: true,
        ssh: {
          publicKeys: [
            {
              path: "/home/azureuser/.ssh/authorized_keys",
              keyData: PUBLIC_KEY,
            },
          ],
        },
      },
    },
    networkProfile: {
      networkApiVersion: "2020-11-01",
      networkInterfaceConfigurations: [
        {
          name: "nic",
          properties: {
            primary: true,
            deleteOption: "Delete",
            ipConfigurations: [
              {
                name: "ipconfig",
                properties: { primary: true, subnet: { id: subnetId } },
              },
            ],
          },
        },
      ],
    },
  },
});

const network = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: LOCATION,
  });
  const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
    resourceGroup: group.resourceGroupName,
    location: LOCATION,
    addressPrefixes: ["10.0.0.0/16"],
  });
  const subnet = yield* Azure.Network.Subnet("Vms", {
    resourceGroup: group.resourceGroupName,
    virtualNetwork: vnet.virtualNetworkName,
    addressPrefix: "10.0.1.0/24",
  });
  return { group, subnet };
});

const program = (props: {
  capacity: number;
  computerNamePrefix: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, subnet } = yield* network;
    const fleet = yield* Azure.AzureFleet.Fleet("Fleet", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      vmSizesProfile: [
        { name: SIZE, rank: 0 },
        { name: SIZE_ALT, rank: 1 },
      ],
      regularPriorityProfile: {
        capacity: props.capacity,
        minCapacity: 1,
        allocationStrategy: "Prioritized",
      },
      computeProfile: Output.map(subnet.subnetId, (subnetId) =>
        computeProfile(subnetId, props.computerNamePrefix),
      ),
      tags: props.tags,
    });
    return { group, fleet };
  });

// At most two 1-vCPU VMs (~$0.03/hour each) for ~20 minutes: < $0.05.
test.provider(
  "create, replace, scale, and delete a compute fleet",
  (stack) =>
    Effect.gen(function* () {
      for (const resourceName of [
        "StandardFalsv7Family",
        "StandardFasv7Family",
      ]) {
        yield* ensureQuota({
          provider: "Microsoft.Compute",
          resourceName,
          minimum: 2,
          location: LOCATION,
        });
      }
      yield* stack.destroy();

      const { group, fleet } = yield* stack.deploy(
        program({
          capacity: 1,
          computerNamePrefix: "fleeta",
          tags: { env: "test" },
        }),
      );
      expect(fleet.provisioningState).toEqual("Succeeded");
      expect(fleet.regularCapacity).toEqual(1);
      expect(fleet.vmSizes).toEqual([SIZE, SIZE_ALT]);
      expect(fleet.tags).toEqual({ env: "test" });
      const observed = yield* getFleet(
        group.resourceGroupName,
        fleet.fleetName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Fleet");

      // The VM template is fixed at creation: replacement.
      const replaced = yield* stack.deploy(
        program({
          capacity: 1,
          computerNamePrefix: "fleetb",
          tags: { env: "test" },
        }),
      );
      expect(replaced.fleet.fleetName).not.toEqual(fleet.fleetName);
      expect(
        yield* untilGone(getFleet(group.resourceGroupName, fleet.fleetName)),
      ).toEqual("gone");

      // In place: scale out and change tags.
      const scaled = yield* stack.deploy(
        program({
          capacity: 2,
          computerNamePrefix: "fleetb",
          tags: { env: "prod" },
        }),
      );
      expect(scaled.fleet.fleetId).toEqual(replaced.fleet.fleetId);
      expect(scaled.fleet.regularCapacity).toEqual(2);
      const reobserved = yield* getFleet(
        group.resourceGroupName,
        replaced.fleet.fleetName,
      );
      expect(reobserved.properties?.regularPriorityProfile?.capacity).toEqual(
        2,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getFleet(group.resourceGroupName, replaced.fleet.fleetName),
        ),
      ).toEqual("gone");
    }).pipe(withVcpus(2), logLevel),
  { tags, timeout: 900_000 },
);
