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
  outboundRuleFqdn: string,
) =>
  Effect.gen(function* () {
    return yield* sql.GetOutboundFirewallRule({
      subscriptionId: yield* subscription,
      resourceGroupName,
      serverName,
      outboundRuleFqdn,
    });
  });

const program = (password: Redacted.Redacted<string>, fqdn: string) =>
  Effect.gen(function* () {
    const { group, server } = yield* sqlServer(password, {
      restrictOutboundNetworkAccess: "Enabled",
    });
    const rule = yield* Azure.Sql.OutboundFirewallRule("Storage", {
      resourceGroup: group.resourceGroupName,
      server: server.serverName,
      fqdn,
    });
    return { group, server, rule };
  });

const FIRST = "alchemyoutbound.blob.core.windows.net";
const SECOND = "alchemyoutbound.queue.core.windows.net";

// The server and outbound firewall rules are free.
test.provider(
  "create, replace, and delete a sql outbound firewall rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const { group, server, rule } = yield* stack.deploy(
        program(password, FIRST),
      );
      expect(rule.fqdn).toEqual(FIRST);
      const observed = yield* getRule(
        group.resourceGroupName,
        server.serverName,
        FIRST,
      );
      expect(observed.properties?.provisioningState).toEqual("Ready");

      // The FQDN is the rule's name, so changing it replaces the rule.
      const replaced = yield* stack.deploy(program(password, SECOND));
      expect(replaced.rule.fqdn).toEqual(SECOND);
      expect(
        yield* awaitGone(
          getRule(group.resourceGroupName, server.serverName, FIRST),
        ),
      ).toEqual("gone");
      expect(
        (yield* getRule(group.resourceGroupName, server.serverName, SECOND))
          .name,
      ).toEqual(SECOND);

      yield* stack.destroy();
      expect(
        yield* awaitGone(
          getRule(group.resourceGroupName, server.serverName, SECOND),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 900_000 },
);
