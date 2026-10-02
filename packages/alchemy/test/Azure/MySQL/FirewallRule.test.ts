import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as mysql from "@distilled.cloud/azure/mysql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, serverRef, tags, testServer, untilGone } from "./server.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: { name: string; endIpAddress: string }) =>
  Effect.gen(function* () {
    const { group, server } = yield* testServer();
    const rule = yield* Azure.MySQL.FirewallRule("Office", {
      resourceGroup: group.resourceGroupName,
      server: server.serverName,
      name: props.name,
      startIpAddress: "203.0.113.1",
      endIpAddress: props.endIpAddress,
    });
    return { group, server, rule };
  });

const getRule = (
  resourceGroupName: string,
  serverName: string,
  firewallRuleName: string,
) =>
  Effect.gen(function* () {
    const ref = yield* serverRef(resourceGroupName, serverName);
    return yield* mysql.GetFirewallRule({ ...ref, firewallRuleName });
  });

// One Burstable B1ms server (≈ $0.02/h) for ~10 minutes.
test.provider(
  "create, update, replace, and delete a firewall rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, server, rule } = yield* stack.deploy(
        program({ name: "office", endIpAddress: "203.0.113.1" }),
      );
      expect(rule.firewallRuleName).toEqual("office");
      const observed = yield* getRule(
        group.resourceGroupName,
        server.serverName,
        "office",
      );
      expect(observed.properties.startIpAddress).toEqual("203.0.113.1");
      expect(observed.properties.endIpAddress).toEqual("203.0.113.1");

      // The range is mutable in place.
      const updated = yield* stack.deploy(
        program({ name: "office", endIpAddress: "203.0.113.255" }),
      );
      expect(updated.rule.firewallRuleId).toEqual(rule.firewallRuleId);
      const reobserved = yield* getRule(
        group.resourceGroupName,
        server.serverName,
        "office",
      );
      expect(reobserved.properties.endIpAddress).toEqual("203.0.113.255");

      // Renaming replaces the rule.
      const renamed = yield* stack.deploy(
        program({ name: "office-v2", endIpAddress: "203.0.113.255" }),
      );
      expect(renamed.rule.firewallRuleName).toEqual("office-v2");
      expect(
        yield* untilGone(
          getRule(group.resourceGroupName, server.serverName, "office"),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getRule(group.resourceGroupName, server.serverName, "office-v2"),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
