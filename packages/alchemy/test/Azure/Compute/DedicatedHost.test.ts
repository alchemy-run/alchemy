import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/azure/compute";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getHost = (
  resourceGroupName: string,
  hostGroupName: string,
  hostName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    compute.GetDedicatedHost({
      subscriptionId,
      resourceGroupName,
      hostGroupName,
      hostName,
    }),
  );

const program = (props: {
  autoReplaceOnFailure: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const hostGroup = yield* Azure.Compute.DedicatedHostGroup("Hosts", {
      resourceGroup: group.resourceGroupName,
    });
    const host = yield* Azure.Compute.DedicatedHost("Host", {
      resourceGroup: group.resourceGroupName,
      hostGroup: hostGroup.hostGroupName,
      sku: "DSv3-Type4",
      autoReplaceOnFailure: props.autoReplaceOnFailure,
      tags: props.tags,
    });
    return { group, hostGroup, host };
  });

test.provider(
  "probe: dedicated host creation is rejected without dedicated host quota",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { subscriptionId: id } = yield* Azure.AzureEnvironment.current;
      // Out of band: an empty host group, then a host PUT that the trial
      // rejects before allocating (and billing) anything.
      const group = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          const hostGroup = yield* Azure.Compute.DedicatedHostGroup("Hosts", {
            resourceGroup: group.resourceGroupName,
          });
          return { group, hostGroup };
        }),
      );
      const error = yield* compute
        .DedicatedHostsCreateOrUpdate({
          subscriptionId: id,
          resourceGroupName: group.group.resourceGroupName,
          hostGroupName: group.hostGroup.hostGroupName,
          hostName: "probe",
          location: "eastus",
          sku: { name: "DSv3-Type4" },
          properties: { platformFaultDomain: 0 },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("QuotaExceeded");
      // Pay-as-you-go subscriptions check the host's VM family quota
      // (standardDSv3Family, 10 cores) against the whole host (119 cores).
      expect(error.message).toContain("standardDSv3Family Cores quota");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);

// A whole DSv3 host costs ~$4-7/hour and needs 119 cores of
// standardDSv3Family quota (10 on a new pay-as-you-go subscription): paid
// subscriptions with raised quota only.
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete a dedicated host",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, hostGroup, host } = yield* stack.deploy(
        program({ autoReplaceOnFailure: true, tags: { env: "test" } }),
      );
      expect(host.sku).toEqual("DSv3-Type4");
      expect(host.hostId).toBeDefined();
      const observed = yield* getHost(
        group.resourceGroupName,
        hostGroup.hostGroupName,
        host.hostName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      // In place: auto-replace and tags.
      const updated = yield* stack.deploy(
        program({ autoReplaceOnFailure: false, tags: { env: "prod" } }),
      );
      expect(updated.host.dedicatedHostId).toEqual(host.dedicatedHostId);
      const reobserved = yield* getHost(
        group.resourceGroupName,
        hostGroup.hostGroupName,
        host.hostName,
      );
      expect(reobserved.properties?.autoReplaceOnFailure).toEqual(false);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getHost(
            group.resourceGroupName,
            hostGroup.hostGroupName,
            host.hostName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
