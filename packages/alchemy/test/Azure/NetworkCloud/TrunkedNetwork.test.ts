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
    return yield* nc.GetTrunkedNetwork({
      subscriptionId: yield* subscription,
      resourceGroupName,
      trunkedNetworkName: name,
    });
  });

const program = (props: { env: string; vlans: number[] }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const res = yield* Azure.NetworkCloud.TrunkedNetwork("Network", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      customLocationId,
      isolationDomainIds: [nexus.l2IsolationDomainId],
      vlans: props.vlans,
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
  "create, update, replace, and delete a Nexus trunked network",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, res } = yield* stack.deploy(
        program({ env: "a", vlans: [500] }),
      );
      const observed = yield* get(
        group.resourceGroupName,
        res.trunkedNetworkName,
      );
      expect(observed.properties.vlans).toEqual([500]);
      expect(observed.tags?.env).toEqual("a");

      // In place.
      const updated = yield* stack.deploy(program({ env: "b", vlans: [500] }));
      expect(updated.res.trunkedNetworkId).toEqual(res.trunkedNetworkId);
      const reobserved = yield* get(
        group.resourceGroupName,
        res.trunkedNetworkName,
      );
      expect(reobserved.tags?.env).toEqual("b");

      // Replacement.
      const replaced = yield* stack.deploy(
        program({ env: "b", vlans: [500, 501] }),
      );
      expect(replaced.res.trunkedNetworkId).not.toEqual(res.trunkedNetworkId);
      expect(
        yield* waitGone(get(group.resourceGroupName, res.trunkedNetworkName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          get(group.resourceGroupName, replaced.res.trunkedNetworkName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe: the trial has no Operator Nexus cluster, so the RP rejects
// a PUT against a custom location that does not exist. Only a resource group
// is created ($0, ~1 minute).
test.provider(
  "the trial rejects a Nexus trunked network without a cluster custom location",
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
        .TrunkedNetworksCreateOrUpdate({
          subscriptionId,
          resourceGroupName,
          location: "eastus",
          trunkedNetworkName: "probe",
          extendedLocation: bogusCustomLocation(
            subscriptionId,
            resourceGroupName,
          ),
          properties: {
            isolationDomainIds: [
              `${pre}/Microsoft.ManagedNetworkFabric/l2IsolationDomains/nol2`,
            ],
            vlans: [500],
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("CustomLocationNotFound");
      expect(error.message).toContain("custom location was not found");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
