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

const getAlias = (
  resourceGroupName: string,
  serverName: string,
  dnsAliasName: string,
) =>
  Effect.gen(function* () {
    return yield* sql.GetServerDnsAlias({
      subscriptionId: yield* subscription,
      resourceGroupName,
      serverName,
      dnsAliasName,
    });
  });

const program = (password: Redacted.Redacted<string>, name?: string) =>
  Effect.gen(function* () {
    const { group, server } = yield* sqlServer(password);
    const alias = yield* Azure.Sql.ServerDnsAlias("Alias", {
      resourceGroup: group.resourceGroupName,
      server: server.serverName,
      name,
    });
    return { group, server, alias };
  });

// The server and DNS aliases are free.
test.provider(
  "create, replace, and delete a sql server dns alias",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const { group, server, alias } = yield* stack.deploy(program(password));
      expect(alias.azureDnsRecord).toContain(alias.dnsAliasName);
      const observed = yield* getAlias(
        group.resourceGroupName,
        server.serverName,
        alias.dnsAliasName,
      );
      expect(observed.properties?.azureDnsRecord).toEqual(alias.azureDnsRecord);

      // Re-deploying the same alias is a no-op.
      const same = yield* stack.deploy(program(password));
      expect(same.alias.dnsAliasId).toEqual(alias.dnsAliasId);

      // Renaming replaces the alias. The name is a global DNS label, so it
      // is derived from the generated alias name.
      const renamed = `${alias.dnsAliasName.slice(0, 36)}-alt`;
      const replaced = yield* stack.deploy(program(password, renamed));
      expect(replaced.alias.dnsAliasName).toEqual(renamed);
      expect(
        yield* awaitGone(
          getAlias(
            group.resourceGroupName,
            server.serverName,
            alias.dnsAliasName,
          ),
        ),
      ).toEqual("gone");
      const observedRenamed = yield* getAlias(
        group.resourceGroupName,
        server.serverName,
        renamed,
      );
      expect(observedRenamed.name).toEqual(renamed);

      yield* stack.destroy();
      expect(
        yield* awaitGone(
          getAlias(group.resourceGroupName, server.serverName, renamed),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 900_000 },
);
