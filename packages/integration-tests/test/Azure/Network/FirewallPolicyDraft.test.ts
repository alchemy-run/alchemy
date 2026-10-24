import * as Azure from "@alchemy.run/azure";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPolicy = (resourceGroupName: string, firewallPolicyName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetFirewallPolicy({ subscriptionId, resourceGroupName, firewallPolicyName }),
  );

const getDraft = (resourceGroupName: string, firewallPolicyName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetFirewallPolicyDraft({ subscriptionId, resourceGroupName, firewallPolicyName }),
  );

// Firewall policies and their drafts are free without firewalls.
const program = (threatIntelMode: "Deny" | "Off") =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const policy = yield* Azure.Network.FirewallPolicy("Policy", {
      resourceGroup: group.resourceGroupName,
      threatIntelMode: "Alert",
    });
    const draft = yield* Azure.Network.FirewallPolicyDraft("Draft", {
      resourceGroup: group.resourceGroupName,
      firewallPolicy: policy.firewallPolicyName,
      threatIntelMode,
    });
    return { group, policy, draft };
  });

test.provider(
  "create, update, and delete a firewall policy draft",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, policy, draft } = yield* stack.deploy(program("Deny"));
      expect(draft.draftName).toEqual("default");
      expect(draft.threatIntelMode).toEqual("Deny");
      const observed = yield* getDraft(group.resourceGroupName, policy.firewallPolicyName);
      expect(observed.properties?.threatIntelMode).toEqual("Deny");
      // The draft does not change the live policy.
      const live = yield* getPolicy(group.resourceGroupName, policy.firewallPolicyName);
      expect(live.properties?.threatIntelMode).toEqual("Alert");

      const updated = yield* stack.deploy(program("Off"));
      expect(updated.draft.draftId).toEqual(draft.draftId);
      const reobserved = yield* getDraft(group.resourceGroupName, policy.firewallPolicyName);
      expect(reobserved.properties?.threatIntelMode).toEqual("Off");

      yield* stack.destroy();
      expect(
        yield* untilGone(getDraft(group.resourceGroupName, policy.firewallPolicyName)),
      ).toEqual("gone");
      expect(
        yield* untilGone(getPolicy(group.resourceGroupName, policy.firewallPolicyName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
