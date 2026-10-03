import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getGroup = (
  resourceGroupName: string,
  vpnServerConfigurationName: string,
  configurationPolicyGroupName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetConfigurationPolicyGroup({
      subscriptionId,
      resourceGroupName,
      vpnServerConfigurationName,
      configurationPolicyGroupName,
    }),
  );
const getConfig = (
  resourceGroupName: string,
  vpnServerConfigurationName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetVpnServerConfiguration({
      subscriptionId,
      resourceGroupName,
      vpnServerConfigurationName,
    }),
  );

const AZURE_VPN_AUDIENCE = "c632b3df-fb67-4d84-bdcf-b95ad541b5c8";

// VPN server configurations and their policy groups are free.
const program = (props: { priority: number; env: string }) =>
  Effect.gen(function* () {
    const { tenantId } = yield* Azure.AzureEnvironment.current;
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const config = yield* Azure.Network.VpnServerConfiguration("P2s", {
      resourceGroup: group.resourceGroupName,
      vpnProtocols: ["OpenVPN"],
      vpnAuthenticationTypes: ["AAD"],
      aad: {
        tenant: `https://login.microsoftonline.com/${tenantId}`,
        audience: AZURE_VPN_AUDIENCE,
        issuer: `https://sts.windows.net/${tenantId}/`,
      },
      tags: { env: props.env },
    });
    const policyGroup = yield* Azure.Network.VpnServerConfigurationPolicyGroup(
      "Engineering",
      {
        resourceGroup: group.resourceGroupName,
        vpnServerConfiguration: config.vpnServerConfigurationName,
        isDefault: true,
        priority: props.priority,
        policyMembers: [
          {
            name: "eng",
            attributeType: "AADGroupId",
            attributeValue: "6ad1bd08-1111-2222-3333-444455556666",
          },
        ],
      },
    );
    return { group, config, policyGroup };
  });

test.provider(
  "create, update, and delete a VPN server configuration policy group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, config, policyGroup } = yield* stack.deploy(
        program({ priority: 0, env: "test" }),
      );
      expect(policyGroup.isDefault).toEqual(true);
      const observed = yield* getGroup(
        group.resourceGroupName,
        config.vpnServerConfigurationName,
        policyGroup.policyGroupName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.policyMembers?.[0]?.attributeType).toEqual(
        "AADGroupId",
      );

      // A tag update on the parent PUT must keep the group.
      const updated = yield* stack.deploy(program({ priority: 5, env: "prod" }));
      expect(updated.policyGroup.policyGroupId).toEqual(
        policyGroup.policyGroupId,
      );
      const reobserved = yield* getGroup(
        group.resourceGroupName,
        config.vpnServerConfigurationName,
        policyGroup.policyGroupName,
      );
      expect(reobserved.properties?.priority).toEqual(5);
      const parent = yield* getConfig(
        group.resourceGroupName,
        config.vpnServerConfigurationName,
      );
      expect(parent.tags?.env).toEqual("prod");
      expect(parent.properties?.configurationPolicyGroups?.length).toEqual(1);

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getConfig(group.resourceGroupName, config.vpnServerConfigurationName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
