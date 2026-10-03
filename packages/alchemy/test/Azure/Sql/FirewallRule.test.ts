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
  firewallRuleName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* sql.GetFirewallRule({
      subscriptionId,
      resourceGroupName,
      serverName,
      firewallRuleName,
    });
  });

const ruleGone = (
  resourceGroupName: string,
  serverName: string,
  firewallRuleName: string,
) =>
  getRule(resourceGroupName, serverName, firewallRuleName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 20,
    }),
  );

const program = (props: {
  password: Redacted.Redacted<string>;
  ruleName?: string;
  endIpAddress: string;
}) =>
  Effect.gen(function* () {
    // The free trial refuses new SQL servers in eastus (`ProvisioningDisabled`).
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "centralus",
    });
    const server = yield* Azure.Sql.Server("Db", {
      resourceGroup: group.resourceGroupName,
      location: group.location,
      administratorLogin: "alchemyadmin",
      administratorLoginPassword: props.password,
    });
    const rule = yield* Azure.Sql.FirewallRule("Office", {
      resourceGroup: group.resourceGroupName,
      server: server.serverName,
      name: props.ruleName,
      startIpAddress: "203.0.113.0",
      endIpAddress: props.endIpAddress,
    });
    return { group, server, rule };
  });

test.provider(
  "create, update, replace, and delete a sql firewall rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = Redacted.make(
        `Az!${yield* Effect.sync(() => randomUUID())}`,
      );

      const { group, server, rule } = yield* stack.deploy(
        program({ password, endIpAddress: "203.0.113.15" }),
      );
      expect(rule.startIpAddress).toEqual("203.0.113.0");
      expect(rule.endIpAddress).toEqual("203.0.113.15");
      const observed = yield* getRule(
        group.resourceGroupName,
        server.serverName,
        rule.firewallRuleName,
      );
      expect(observed.properties?.endIpAddress).toEqual("203.0.113.15");

      // In place: widen the range.
      const updated = yield* stack.deploy(
        program({ password, endIpAddress: "203.0.113.255" }),
      );
      expect(updated.rule.firewallRuleName).toEqual(rule.firewallRuleName);
      const reobserved = yield* getRule(
        group.resourceGroupName,
        server.serverName,
        rule.firewallRuleName,
      );
      expect(reobserved.properties?.endIpAddress).toEqual("203.0.113.255");

      // Renaming replaces the rule.
      const replaced = yield* stack.deploy(
        program({
          password,
          ruleName: "alchemy-office-renamed",
          endIpAddress: "203.0.113.255",
        }),
      );
      expect(replaced.rule.firewallRuleName).toEqual("alchemy-office-renamed");
      expect(
        yield* ruleGone(
          group.resourceGroupName,
          server.serverName,
          rule.firewallRuleName,
        ),
      ).toEqual("gone");
      const renamed = yield* getRule(
        group.resourceGroupName,
        server.serverName,
        "alchemy-office-renamed",
      );
      expect(renamed.properties?.startIpAddress).toEqual("203.0.113.0");

      yield* stack.destroy();
      expect(
        yield* ruleGone(
          group.resourceGroupName,
          server.serverName,
          "alchemy-office-renamed",
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:sql", "live"],
    timeout: 600_000,
  },
);
