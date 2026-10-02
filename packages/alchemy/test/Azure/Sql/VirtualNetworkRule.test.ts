import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as sql from "@distilled.cloud/azure/sql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { randomUUID } from "node:crypto";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getRule = (
  resourceGroupName: string,
  serverName: string,
  virtualNetworkRuleName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* sql.GetVirtualNetworkRule({
      subscriptionId,
      resourceGroupName,
      serverName,
      virtualNetworkRuleName,
    });
  });

const ruleGone = (
  resourceGroupName: string,
  serverName: string,
  virtualNetworkRuleName: string,
) =>
  getRule(resourceGroupName, serverName, virtualNetworkRuleName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

const program = (props: {
  password: Redacted.Redacted<string>;
  subnet: "A" | "B" | undefined;
}) =>
  Effect.gen(function* () {
    // The free trial refuses new SQL servers in eastus (`ProvisioningDisabled`).
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "centralus",
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      location: group.location,
      addressPrefixes: ["10.61.0.0/16"],
    });
    // Both subnets stay deployed across the update so the rule never
    // loses its old dependency mid-deploy.
    const subnetA = yield* Azure.Network.Subnet("A", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.61.1.0/24",
      serviceEndpoints: [{ service: "Microsoft.Sql" }],
    });
    const subnetB = yield* Azure.Network.Subnet("B", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.61.2.0/24",
      serviceEndpoints: [{ service: "Microsoft.Sql" }],
    });
    const server = yield* Azure.Sql.Server("Db", {
      resourceGroup: group.resourceGroupName,
      location: group.location,
      administratorLogin: "alchemyadmin",
      administratorLoginPassword: props.password,
    });
    const rule =
      props.subnet === undefined
        ? undefined
        : yield* Azure.Sql.VirtualNetworkRule("Apps", {
            resourceGroup: group.resourceGroupName,
            server: server.serverName,
            virtualNetworkSubnetId:
              props.subnet === "A" ? subnetA.subnetId : subnetB.subnetId,
          });
    return { group, server, subnetA, subnetB, rule };
  });

test.provider(
  "create, retarget, and delete a sql virtual network rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = Redacted.make(
        `Az!${yield* Effect.sync(() => randomUUID())}`,
      );

      const { group, server, subnetA, rule } = yield* stack.deploy(
        program({ password, subnet: "A" }),
      );
      expect(rule?.state).toEqual("Ready");
      const observed = yield* getRule(
        group.resourceGroupName,
        server.serverName,
        rule!.virtualNetworkRuleName,
      );
      expect(
        observed.properties?.virtualNetworkSubnetId?.toLowerCase(),
      ).toEqual(subnetA.subnetId.toLowerCase());

      // In place: point the rule at the second subnet.
      const updated = yield* stack.deploy(program({ password, subnet: "B" }));
      expect(updated.rule?.virtualNetworkRuleId).toEqual(
        rule?.virtualNetworkRuleId,
      );
      const reobserved = yield* getRule(
        group.resourceGroupName,
        server.serverName,
        rule!.virtualNetworkRuleName,
      );
      expect(
        reobserved.properties?.virtualNetworkSubnetId?.toLowerCase(),
      ).toEqual(updated.subnetB.subnetId.toLowerCase());

      // Removing the rule deletes it while the server stays.
      yield* stack.deploy(program({ password, subnet: undefined }));
      expect(
        yield* ruleGone(
          group.resourceGroupName,
          server.serverName,
          rule!.virtualNetworkRuleName,
        ),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:sql", "live"],
    timeout: 600_000,
  },
);
