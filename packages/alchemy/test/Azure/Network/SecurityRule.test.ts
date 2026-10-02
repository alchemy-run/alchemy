import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRule = (
  resourceGroupName: string,
  networkSecurityGroupName: string,
  securityRuleName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetSecurityRule({
      subscriptionId,
      resourceGroupName,
      networkSecurityGroupName,
      securityRuleName,
    }),
  );

// NSGs, rules, and application security groups are free.
const program = (props: {
  httpsPriority: number;
  httpsPort: string;
  useAsgSource: boolean;
  nsgTags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const nsg = yield* Azure.Network.NetworkSecurityGroup("Web", {
      resourceGroup: group.resourceGroupName,
      tags: props.nsgTags,
    });
    const app = yield* Azure.Network.ApplicationSecurityGroup("App", {
      resourceGroup: group.resourceGroupName,
    });
    // Two rules on one NSG deploy concurrently; the RP serialises them.
    const https = yield* Azure.Network.SecurityRule("AllowHttps", {
      resourceGroup: group.resourceGroupName,
      networkSecurityGroup: nsg.networkSecurityGroupName,
      priority: props.httpsPriority,
      direction: "Inbound",
      access: "Allow",
      protocol: "Tcp",
      destinationPortRange: props.httpsPort,
      ...(props.useAsgSource
        ? {
            sourceApplicationSecurityGroupIds: [app.applicationSecurityGroupId],
          }
        : { sourceAddressPrefix: "Internet" }),
      destinationApplicationSecurityGroupIds: props.useAsgSource
        ? [app.applicationSecurityGroupId]
        : undefined,
      description: "https in",
    });
    const deny = yield* Azure.Network.SecurityRule("DenyOutbound", {
      resourceGroup: group.resourceGroupName,
      networkSecurityGroup: nsg.networkSecurityGroupName,
      priority: 4000,
      direction: "Outbound",
      access: "Deny",
      protocol: "*",
      destinationAddressPrefixes: ["203.0.113.0/24", "198.51.100.0/24"],
    });
    return { group, nsg, app, https, deny };
  });

test.provider(
  "create, update, and delete security rules",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, nsg, https, deny } = yield* stack.deploy(
        program({
          httpsPriority: 100,
          httpsPort: "443",
          useAsgSource: false,
          nsgTags: { env: "test" },
        }),
      );
      expect(https.priority).toEqual(100);
      expect(https.description).toEqual("https in");
      const observed = yield* getRule(
        group.resourceGroupName,
        nsg.networkSecurityGroupName,
        https.securityRuleName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.sourceAddressPrefix).toEqual("Internet");
      expect(observed.properties?.destinationPortRange).toEqual("443");
      expect(observed.properties?.description).toMatch(
        /^https in \[alchemy .+\/AllowHttps\]$/,
      );
      const denied = yield* getRule(
        group.resourceGroupName,
        nsg.networkSecurityGroupName,
        deny.securityRuleName,
      );
      expect(
        [...(denied.properties?.destinationAddressPrefixes ?? [])].sort(),
      ).toEqual(["198.51.100.0/24", "203.0.113.0/24"]);

      // Update priority + port and swap the source to an ASG; also update
      // the NSG, which must keep both rules.
      const updated = yield* stack.deploy(
        program({
          httpsPriority: 110,
          httpsPort: "8443",
          useAsgSource: true,
          nsgTags: { env: "prod" },
        }),
      );
      expect(updated.https.securityRuleId).toEqual(https.securityRuleId);
      const reobserved = yield* getRule(
        group.resourceGroupName,
        nsg.networkSecurityGroupName,
        https.securityRuleName,
      );
      expect(reobserved.properties?.priority).toEqual(110);
      expect(reobserved.properties?.destinationPortRange).toEqual("8443");
      expect(reobserved.properties?.sourceAddressPrefix).toBeUndefined();
      expect(
        reobserved.properties?.sourceApplicationSecurityGroups?.[0]?.id?.toLowerCase(),
      ).toEqual(updated.app.applicationSecurityGroupId.toLowerCase());
      const parent = yield* Effect.flatMap(subscriptionId, (subscriptionId) =>
        network.GetNetworkSecurityGroup({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          networkSecurityGroupName: nsg.networkSecurityGroupName,
        }),
      );
      expect(parent.tags?.env).toEqual("prod");
      expect(
        (parent.properties?.securityRules ?? []).map((r) => r.name).sort(),
      ).toEqual([https.securityRuleName, deny.securityRuleName].sort());

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getRule(
            group.resourceGroupName,
            nsg.networkSecurityGroupName,
            https.securityRuleName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
