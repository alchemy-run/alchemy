import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as sql from "@distilled.cloud/azure/sql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import {
  awaitGone,
  logLevel,
  newPassword,
  SQL_TAGS,
  sqlServer,
  subscription,
} from "./harness.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRule = (
  resourceGroupName: string,
  serverName: string,
  firewallRuleName: string,
) =>
  Effect.gen(function* () {
    return yield* sql.GetIPv6FirewallRule({
      subscriptionId: yield* subscription,
      resourceGroupName,
      serverName,
      firewallRuleName,
    });
  });

const program = (
  password: Redacted.Redacted<string>,
  props: { name?: string; endIPv6Address: string },
) =>
  Effect.gen(function* () {
    // Rules can be managed before IPv6 connectivity is enabled on the
    // server (the trial's centralus servers do not accept isIPv6Enabled).
    const { group, server } = yield* sqlServer(password);
    const rule = yield* Azure.Sql.IPv6FirewallRule("Office", {
      resourceGroup: group.resourceGroupName,
      server: server.serverName,
      name: props.name,
      startIPv6Address: "2001:db8::",
      endIPv6Address: props.endIPv6Address,
    });
    return { group, server, rule };
  });

// The server and firewall rules are free.
test.provider(
  "create, update, replace, and delete a sql ipv6 firewall rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const { group, server, rule } = yield* stack.deploy(
        program(password, { endIPv6Address: "2001:db8::ff" }),
      );
      const observed = yield* getRule(
        group.resourceGroupName,
        server.serverName,
        rule.firewallRuleName,
      );
      expect(observed.properties?.endIPv6Address).toEqual("2001:db8::ff");

      // In place: widen the range.
      const updated = yield* stack.deploy(
        program(password, { endIPv6Address: "2001:db8::ffff" }),
      );
      expect(updated.rule.firewallRuleName).toEqual(rule.firewallRuleName);
      expect(
        (yield* getRule(
          group.resourceGroupName,
          server.serverName,
          rule.firewallRuleName,
        )).properties?.endIPv6Address,
      ).toEqual("2001:db8::ffff");

      // Renaming replaces the rule.
      const replaced = yield* stack.deploy(
        program(password, {
          name: "alchemy-office-v6",
          endIPv6Address: "2001:db8::ffff",
        }),
      );
      expect(replaced.rule.firewallRuleName).toEqual("alchemy-office-v6");
      expect(
        yield* awaitGone(
          getRule(
            group.resourceGroupName,
            server.serverName,
            rule.firewallRuleName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* awaitGone(
          getRule(
            group.resourceGroupName,
            server.serverName,
            "alchemy-office-v6",
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 900_000 },
);
