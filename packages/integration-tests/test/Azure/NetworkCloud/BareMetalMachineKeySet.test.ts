import * as Azure from "@alchemy.run/azure";
import * as nc from "@distilled.cloud/azure/networkcloud";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  azureGroupId,
  bogusCustomLocation,
  customLocationId,
  logLevel,
  nexusCluster,
  sshKey,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const get = (name: string) =>
  Effect.gen(function* () {
    return yield* nc.GetBareMetalMachineKeySet({
      subscriptionId: yield* subscription,
      resourceGroupName: nexusCluster.resourceGroup,
      clusterName: nexusCluster.name,
      bareMetalMachineKeySetName: name,
    });
  });

/** Key sets must expire in the future; a month from the test run. */
const expiration = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

const program = (props: {
  privilegeLevel: "Standard" | "Superuser";
  description: string;
  env: string;
}) =>
  Effect.gen(function* () {
    const res = yield* Azure.NetworkCloud.BareMetalMachineKeySet("KeySet", {
      // Key sets live in the resource group of their cluster.
      resourceGroup: nexusCluster.resourceGroup,
      clusterName: nexusCluster.name,
      location: "eastus",
      customLocationId,
      azureGroupId,
      expiration,
      jumpHostsAllowed: ["10.0.0.4"],
      privilegeLevel: props.privilegeLevel,
      userList: [{ azureUserName: "alchemy", description: props.description, sshPublicKey: sshKey }],
      tags: { env: props.env },
    });
    return { res };
  });

// Billed as part of the Nexus cluster; a few minutes once the cluster
// exists. Needs a deployed Operator Nexus cluster on certified on-premises
// racks (AZURE_NEXUS_CLUSTER_ID, AZURE_NEXUS_CUSTOM_LOCATION_ID).
test.provider.skipIf(!runPaidOnly || !customLocationId || !nexusCluster.name)(
  "create, update, replace, and delete a Nexus bare metal machine key set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { res } = yield* stack.deploy(
        program({ privilegeLevel: "Standard", description: "a", env: "a" }),
      );
      const observed = yield* get(res.bareMetalMachineKeySetName);
      expect(observed.properties.privilegeLevel).toEqual("Standard");
      expect(observed.properties.userList[0]?.description).toEqual("a");
      expect(observed.tags?.env).toEqual("a");

      // In place.
      const updated = yield* stack.deploy(
        program({ privilegeLevel: "Standard", description: "b", env: "b" }),
      );
      expect(updated.res.bareMetalMachineKeySetId).toEqual(res.bareMetalMachineKeySetId);
      const reobserved = yield* get(res.bareMetalMachineKeySetName);
      expect(reobserved.properties.userList[0]?.description).toEqual("b");
      expect(reobserved.tags?.env).toEqual("b");

      // Replacement (the privilege level is immutable).
      const replaced = yield* stack.deploy(
        program({ privilegeLevel: "Superuser", description: "b", env: "b" }),
      );
      expect(replaced.res.bareMetalMachineKeySetName).not.toEqual(res.bareMetalMachineKeySetName);
      expect(yield* waitGone(get(res.bareMetalMachineKeySetName))).toEqual("gone");
      const final = yield* get(replaced.res.bareMetalMachineKeySetName);
      expect(final.properties.privilegeLevel).toEqual("Superuser");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.res.bareMetalMachineKeySetName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 1_800_000 },
);

// Ungated probe: the trial has no Operator Nexus cluster, so the RP rejects
// a PUT against a custom location that does not exist. Only a resource group
// is created ($0, ~1 minute).
test.provider(
  "the trial rejects a Nexus bare metal machine key set without a cluster custom location",
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
        .BareMetalMachineKeySetsCreateOrUpdate({
          subscriptionId,
          resourceGroupName,
          location: "eastus",
          clusterName: "nocluster",
          bareMetalMachineKeySetName: "probe",
          extendedLocation: bogusCustomLocation(subscriptionId, resourceGroupName),
          properties: {
            azureGroupId,
            expiration,
            jumpHostsAllowed: ["10.0.0.4"],
            privilegeLevel: "Standard",
            userList: [{ azureUserName: "alchemy", sshPublicKey: sshKey }],
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("CustomLocationNotFound");
      expect(error.message).toContain("custom location was not found");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
