import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getOverrides = (resourceGroupName: string, firewallPolicyName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetFirewallPolicyIdpsSignaturesOverride({
      subscriptionId,
      resourceGroupName,
      firewallPolicyName,
    }),
  );

const program = (
  signatures: Record<string, Azure.Network.IdpsSignatureMode> | undefined,
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const policy = yield* Azure.Network.FirewallPolicy("Policy", {
      resourceGroup: group.resourceGroupName,
      tier: "Premium",
    });
    const overrides =
      signatures === undefined
        ? undefined
        : yield* Azure.Network.FirewallPolicyIdpsSignatureOverrides("Idps", {
            resourceGroup: group.resourceGroupName,
            firewallPolicy: policy.firewallPolicyName,
            signatures,
          });
    return { group, policy, overrides };
  });

// A Premium firewall policy without firewalls is free, but on the trial
// subscription every signatureOverrides call (GET/PUT/PATCH on
// `.../signatureOverrides/default`, api-version 2025-09-01 and 2024-05-01)
// returns an empty-bodied 404 `NotFound` on a standalone, Succeeded Premium
// policy, while `ListFirewallPolicyIdpsSignatures` works. The endpoint
// likely needs the policy attached to a Premium Azure Firewall
// (≈ $1.75/hour, 10+ minutes). Run with AZURE_TEST_PAID=1.
test.provider.skipIf(!runPaidOnly)(
  "set, update, clear, and delete IDPS signature overrides",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, policy, overrides } = yield* stack.deploy(
        program({ "2024897": "Deny" }),
      );
      expect(overrides?.signatures).toEqual({ "2024897": "Deny" });
      const observed = yield* getOverrides(
        group.resourceGroupName,
        policy.firewallPolicyName,
      );
      expect(observed.properties?.signatures).toEqual({ "2024897": "Deny" });

      yield* stack.deploy(program({ "2024897": "Alert", "2024898": "Off" }));
      const updated = yield* getOverrides(
        group.resourceGroupName,
        policy.firewallPolicyName,
      );
      expect(updated.properties?.signatures).toEqual({
        "2024897": "Alert",
        "2024898": "Off",
      });

      // Removing the resource clears the overrides on the surviving policy.
      yield* stack.deploy(program(undefined));
      const cleared = yield* getOverrides(
        group.resourceGroupName,
        policy.firewallPolicyName,
      ).pipe(
        Effect.map((o) => o.properties?.signatures ?? {}),
        Effect.catchTag("NotFound", () => Effect.succeed({})),
      );
      expect(Object.keys(cleared)).toEqual([]);

      yield* stack.destroy();
      expect(
        yield* untilGone(
          Effect.flatMap(subscriptionId, (subscriptionId) =>
            network.GetFirewallPolicy({
              subscriptionId,
              resourceGroupName: group.resourceGroupName,
              firewallPolicyName: policy.firewallPolicyName,
            }),
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
