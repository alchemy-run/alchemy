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
    return yield* nc.GetBmcKeySet({
      subscriptionId: yield* subscription,
      resourceGroupName: nexusCluster.resourceGroup,
      clusterName: nexusCluster.name,
      bmcKeySetName: name,
    });
  });

/** Key sets must expire in the future; a month from the test run. */
const expiration = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

const program = (props: {
  privilegeLevel: "ReadOnly" | "Administrator";
  description: string;
  env: string;
}) =>
  Effect.gen(function* () {
    const res = yield* Azure.NetworkCloud.BmcKeySet("KeySet", {
      // Key sets live in the resource group of their cluster.
      resourceGroup: nexusCluster.resourceGroup,
      clusterName: nexusCluster.name,
      location: "eastus",
      customLocationId,
      azureGroupId,
      expiration,
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
  "create, update, replace, and delete a Nexus BMC key set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { res } = yield* stack.deploy(
        program({ privilegeLevel: "ReadOnly", description: "a", env: "a" }),
      );
      const observed = yield* get(res.bmcKeySetName);
      expect(observed.properties.privilegeLevel).toEqual("ReadOnly");
      expect(observed.properties.userList[0]?.description).toEqual("a");
      expect(observed.tags?.env).toEqual("a");

      // In place.
      const updated = yield* stack.deploy(
        program({ privilegeLevel: "ReadOnly", description: "b", env: "b" }),
      );
      expect(updated.res.bmcKeySetId).toEqual(res.bmcKeySetId);
      const reobserved = yield* get(res.bmcKeySetName);
      expect(reobserved.properties.userList[0]?.description).toEqual("b");
      expect(reobserved.tags?.env).toEqual("b");

      // Replacement (the privilege level is immutable).
      const replaced = yield* stack.deploy(
        program({ privilegeLevel: "Administrator", description: "b", env: "b" }),
      );
      expect(replaced.res.bmcKeySetName).not.toEqual(res.bmcKeySetName);
      expect(yield* waitGone(get(res.bmcKeySetName))).toEqual("gone");
      const final = yield* get(replaced.res.bmcKeySetName);
      expect(final.properties.privilegeLevel).toEqual("Administrator");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.res.bmcKeySetName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 1_800_000 },
);

// Ungated probe: the trial has no Operator Nexus cluster, so the RP rejects
// a PUT against a custom location that does not exist. Only a resource group
// is created ($0, ~1 minute).
test.provider(
  "the trial rejects a Nexus BMC key set without a cluster custom location",
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
        .BmcKeySetsCreateOrUpdate({
          subscriptionId,
          resourceGroupName,
          location: "eastus",
          clusterName: "nocluster",
          bmcKeySetName: "probe",
          extendedLocation: bogusCustomLocation(subscriptionId, resourceGroupName),
          properties: {
            azureGroupId,
            expiration,
            privilegeLevel: "ReadOnly",
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
