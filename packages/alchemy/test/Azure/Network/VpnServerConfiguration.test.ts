import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConfig = (resourceGroupName: string, vpnServerConfigurationName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetVpnServerConfiguration({
      subscriptionId,
      resourceGroupName,
      vpnServerConfigurationName,
    }),
  );

// Azure VPN client (Microsoft-registered) application ID.
const AZURE_VPN_AUDIENCE = "c632b3df-fb67-4d84-bdcf-b95ad541b5c8";

// VPN server configurations are free and provision in seconds.
const program = (props: { protocols: ("IkeV2" | "OpenVPN")[]; env: string }) =>
  Effect.gen(function* () {
    const { tenantId } = yield* Azure.AzureEnvironment.current;
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const config = yield* Azure.Network.VpnServerConfiguration("P2s", {
      resourceGroup: group.resourceGroupName,
      vpnProtocols: props.protocols,
      vpnAuthenticationTypes: ["AAD"],
      aad: {
        tenant: `https://login.microsoftonline.com/${tenantId}`,
        audience: AZURE_VPN_AUDIENCE,
        issuer: `https://sts.windows.net/${tenantId}/`,
      },
      tags: { env: props.env },
    });
    return { group, config };
  });

test.provider(
  "create, update, and delete a VPN server configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, config } = yield* stack.deploy(
        program({ protocols: ["OpenVPN"], env: "test" }),
      );
      expect(config.vpnAuthenticationTypes).toEqual(["AAD"]);
      const observed = yield* getConfig(
        group.resourceGroupName,
        config.vpnServerConfigurationName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.vpnProtocols).toEqual(["OpenVPN"]);
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(
        program({ protocols: ["OpenVPN", "IkeV2"], env: "prod" }),
      );
      expect(updated.config.vpnServerConfigurationId).toEqual(
        config.vpnServerConfigurationId,
      );
      const reobserved = yield* getConfig(
        group.resourceGroupName,
        config.vpnServerConfigurationName,
      );
      expect([...(reobserved.properties?.vpnProtocols ?? [])].sort()).toEqual([
        "IkeV2",
        "OpenVPN",
      ]);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getConfig(group.resourceGroupName, config.vpnServerConfigurationName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
