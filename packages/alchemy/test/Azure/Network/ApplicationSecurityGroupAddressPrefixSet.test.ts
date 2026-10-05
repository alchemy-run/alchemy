import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import { runPaidOnly } from "../gates.ts";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSet = (
  resourceGroupName: string,
  applicationSecurityGroupName: string,
  addressPrefixSetName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetAddressPrefixSet({
      subscriptionId,
      resourceGroupName,
      applicationSecurityGroupName,
      addressPrefixSetName,
    }),
  );

// Prefix sets are a private preview: subscriptions that Microsoft has not
// allow-listed (pay-as-you-go included) get NetworkFeatureNotSupported
// ("cannot contain more than 0 address prefix sets"), and no
// self-registrable feature flag or Microsoft.Network usage lifts the limit.
// The lifecycle runs with AZURE_TEST_PAID=1 and AZURE_TEST_ASG_PREFIX_SETS=1
// on an allow-listed subscription.
const allowListed = !!process.env.AZURE_TEST_ASG_PREFIX_SETS;

const program = (prefixes: string[]) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const asg = yield* Azure.Network.ApplicationSecurityGroup("Web", {
      resourceGroup: group.resourceGroupName,
    });
    const set = yield* Azure.Network.ApplicationSecurityGroupAddressPrefixSet(
      "OnPrem",
      {
        resourceGroup: group.resourceGroupName,
        applicationSecurityGroup: asg.applicationSecurityGroupName,
        addressPrefixes: prefixes,
      },
    );
    return { group, asg, set };
  });

test.provider.skipIf(!runPaidOnly || !allowListed)(
  "create, update, and delete an application security group address prefix set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, asg, set } = yield* stack.deploy(
        program(["192.168.0.0/24"]),
      );
      expect(set.addressPrefixes).toEqual(["192.168.0.0/24"]);

      const updated = yield* stack.deploy(
        program(["192.168.0.0/24", "192.168.1.0/24"]),
      );
      expect(updated.set.addressPrefixSetId).toEqual(set.addressPrefixSetId);
      const observed = yield* getSet(
        group.resourceGroupName,
        asg.applicationSecurityGroupName,
        set.addressPrefixSetName,
      );
      expect([...(observed.properties?.addressPrefixes ?? [])].sort()).toEqual([
        "192.168.0.0/24",
        "192.168.1.0/24",
      ]);

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getSet(
            group.resourceGroupName,
            asg.applicationSecurityGroupName,
            set.addressPrefixSetName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);

test.provider.skipIf(allowListed)(
  "address prefix sets are rejected with a typed error without the preview",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const sub = yield* subscriptionId;
      const { group, asg } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("ProbeGroup", {
            location: "eastus",
          });
          const asg = yield* Azure.Network.ApplicationSecurityGroup(
            "ProbeAsg",
            {
              resourceGroup: group.resourceGroupName,
            },
          );
          return { group, asg };
        }),
      );
      const error = yield* network
        .AddressPrefixSetsCreateOrUpdate({
          subscriptionId: sub,
          resourceGroupName: group.resourceGroupName,
          applicationSecurityGroupName: asg.applicationSecurityGroupName,
          addressPrefixSetName: "probe",
          properties: { addressPrefixes: ["192.168.0.0/24"] },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("NetworkFeatureNotSupported");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
