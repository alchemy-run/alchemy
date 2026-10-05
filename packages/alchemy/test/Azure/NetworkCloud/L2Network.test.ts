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
  nexus,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const get = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    return yield* nc.GetL2Network({
      subscriptionId: yield* subscription,
      resourceGroupName,
      l2NetworkName: name,
    });
  });

const program = (props: { env: string; interfaceName: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const res = yield* Azure.NetworkCloud.L2Network("Network", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      customLocationId,
      l2IsolationDomainId: nexus.l2IsolationDomainId,
      interfaceName: props.interfaceName,
      tags: { env: props.env },
    });
    return { group, res };
  });

// Needs a deployed Operator Nexus cluster on certified on-premises racks
// (AZURE_NEXUS_CUSTOM_LOCATION_ID, AZURE_NEXUS_L2_ISOLATION_DOMAIN_ID); the trial cannot create one.
// Billed as part of the Nexus cluster; a few minutes once the cluster exists.
test.provider.skipIf(
  !runPaidOnly || !customLocationId || !nexus.l2IsolationDomainId,
)(
  "create, update, replace, and delete a Nexus L2 network",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, res } = yield* stack.deploy(
        program({ env: "a", interfaceName: "l2a" }),
      );
      const observed = yield* get(group.resourceGroupName, res.l2NetworkName);
      expect(observed.properties.interfaceName).toEqual("l2a");
      expect(observed.tags?.env).toEqual("a");

      // In place.
      const updated = yield* stack.deploy(
        program({ env: "b", interfaceName: "l2a" }),
      );
      expect(updated.res.l2NetworkId).toEqual(res.l2NetworkId);
      const reobserved = yield* get(group.resourceGroupName, res.l2NetworkName);
      expect(reobserved.tags?.env).toEqual("b");

      // Replacement.
      const replaced = yield* stack.deploy(
        program({ env: "b", interfaceName: "l2b" }),
      );
      expect(replaced.res.l2NetworkId).not.toEqual(res.l2NetworkId);
      expect(
        yield* waitGone(get(group.resourceGroupName, res.l2NetworkName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          get(group.resourceGroupName, replaced.res.l2NetworkName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe: the trial has no Operator Nexus cluster, so the RP rejects
// a PUT against a custom location that does not exist. Only a resource group
// is created ($0, ~1 minute).
test.provider(
  "the trial rejects a Nexus L2 network without a cluster custom location",
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
      const pre = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers`;
      const error = yield* nc
        .L2NetworksCreateOrUpdate({
          subscriptionId,
          resourceGroupName,
          location: "eastus",
          l2NetworkName: "probe",
          extendedLocation: bogusCustomLocation(
            subscriptionId,
            resourceGroupName,
          ),
          properties: {
            l2IsolationDomainId: `${pre}/Microsoft.ManagedNetworkFabric/l2IsolationDomains/nol2`,
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("CustomLocationNotFound");
      expect(error.message).toContain("custom location was not found");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
