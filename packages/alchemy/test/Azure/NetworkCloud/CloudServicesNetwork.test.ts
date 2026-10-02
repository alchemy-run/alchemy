import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as nc from "@distilled.cloud/azure/networkcloud";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  bogusCustomLocation,
  customLocationId,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const get = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    return yield* nc.GetCloudServicesNetwork({
      subscriptionId: yield* subscription,
      resourceGroupName,
      cloudServicesNetworkName: name,
    });
  });

const program = (props: { env: string; enableDefault: "True" | "False" }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const res = yield* Azure.NetworkCloud.CloudServicesNetwork("Network", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      customLocationId,
      enableDefaultEgressEndpoints: props.enableDefault,
      tags: { env: props.env },
    });
    return { group, res };
  });

// Needs a deployed Operator Nexus cluster on certified on-premises racks
// (AZURE_NEXUS_CUSTOM_LOCATION_ID); the trial cannot create one.
// Billed as part of the Nexus cluster; a few minutes once the cluster exists.
test.provider.skipIf(!runPaidOnly || !customLocationId)(
  "create, update, and delete a Nexus cloud services network",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, res } = yield* stack.deploy(
        program({ env: "a", enableDefault: "False" }),
      );
      const observed = yield* get(
        group.resourceGroupName,
        res.cloudServicesNetworkName,
      );
      expect(observed.properties?.enableDefaultEgressEndpoints).toEqual(
        "False",
      );
      expect(observed.tags?.env).toEqual("a");

      // In place.
      const updated = yield* stack.deploy(
        program({ env: "b", enableDefault: "True" }),
      );
      expect(updated.res.cloudServicesNetworkId).toEqual(
        res.cloudServicesNetworkId,
      );
      const reobserved = yield* get(
        group.resourceGroupName,
        res.cloudServicesNetworkName,
      );
      expect(reobserved.properties?.enableDefaultEgressEndpoints).toEqual(
        "True",
      );
      expect(reobserved.tags?.env).toEqual("b");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          get(group.resourceGroupName, updated.res.cloudServicesNetworkName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe: the trial has no Operator Nexus cluster, so the RP rejects
// a PUT against a custom location that does not exist. Only a resource group
// is created ($0, ~1 minute).
test.provider(
  "the trial rejects a Nexus cloud services network without a cluster custom location",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const subscriptionId = yield* subscription;
      const resourceGroupName = group.resourceGroupName;
      const error = yield* nc
        .CloudServicesNetworksCreateOrUpdate({
          subscriptionId,
          resourceGroupName,
          location: "eastus",
          cloudServicesNetworkName: "probe",
          extendedLocation: bogusCustomLocation(
            subscriptionId,
            resourceGroupName,
          ),
          properties: {},
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("CustomLocationNotFound");
      expect(error.message).toContain("custom location was not found");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
