import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getGroup = (
  resourceGroupName: string,
  firewallPolicyName: string,
  kubeSelectorGroupName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetFirewallPolicyKubeSelectorGroup({
      subscriptionId,
      resourceGroupName,
      firewallPolicyName,
      kubeSelectorGroupName,
    }),
  );

const program = (props: { name: string; app: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const policy = yield* Azure.Network.FirewallPolicy("Policy", {
      resourceGroup: group.resourceGroupName,
    });
    const selector = yield* Azure.Network.FirewallPolicyKubeSelectorGroup(
      "Web",
      {
        resourceGroup: group.resourceGroupName,
        firewallPolicy: policy.firewallPolicyName,
        name: props.name,
        podSelector: { matchLabels: { app: props.app } },
        namespaceSelector: {
          matchExpressions: [
            {
              key: "kubernetes.io/metadata.name",
              operator: "In",
              values: ["prod"],
            },
          ],
        },
      },
    );
    return { group, policy, selector };
  });

// A firewall policy without firewalls (and its selector groups) is free.
test.provider(
  "create, update, replace, and delete a Kubernetes selector group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, policy, selector } = yield* stack.deploy(
        program({ name: "web-a", app: "web" }),
      );
      const observed = yield* getGroup(
        group.resourceGroupName,
        policy.firewallPolicyName,
        "web-a",
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.podSelector?.matchLabels).toEqual({
        app: "web",
      });

      const updated = yield* stack.deploy(
        program({ name: "web-a", app: "api" }),
      );
      expect(updated.selector.kubeSelectorGroupId).toEqual(
        selector.kubeSelectorGroupId,
      );
      const reobserved = yield* getGroup(
        group.resourceGroupName,
        policy.firewallPolicyName,
        "web-a",
      );
      expect(reobserved.properties?.podSelector?.matchLabels).toEqual({
        app: "api",
      });

      yield* stack.deploy(program({ name: "web-b", app: "api" }));
      expect(
        yield* untilGone(
          getGroup(group.resourceGroupName, policy.firewallPolicyName, "web-a"),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getGroup(group.resourceGroupName, policy.firewallPolicyName, "web-b"),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
