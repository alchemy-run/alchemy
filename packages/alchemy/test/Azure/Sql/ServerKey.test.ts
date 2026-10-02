import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as sql from "@distilled.cloud/azure/sql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { cmkServer } from "./cmk.ts";
import {
  awaitGone,
  logLevel,
  newPassword,
  SQL_TAGS,
  subscription,
} from "./harness.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getKey = (resourceGroupName: string, serverName: string, keyName: string) =>
  Effect.gen(function* () {
    return yield* sql.GetServerKey({
      subscriptionId: yield* subscription,
      resourceGroupName,
      serverName,
      keyName,
    });
  });

const program = (password: Redacted.Redacted<string>, which: 0 | 1) =>
  Effect.gen(function* () {
    const { group, server, keys } = yield* cmkServer(password, [
      "KeyA",
      "KeyB",
    ]);
    const serverKey = yield* Azure.Sql.ServerKey("TdeKey", {
      resourceGroup: group.resourceGroupName,
      server: server.serverName,
      uri: keys[which]!.keyUriWithVersion,
    });
    return { group, server, serverKey };
  });

// Server, standard Key Vault, and two RSA keys: < $0.01 per run.
test.provider(
  "register, replace, and remove a sql server key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const { group, server, serverKey } = yield* stack.deploy(
        program(password, 0),
      );
      expect(serverKey.serverKeyType).toEqual("AzureKeyVault");
      const observed = yield* getKey(
        group.resourceGroupName,
        server.serverName,
        serverKey.serverKeyName,
      );
      expect(observed.properties?.uri).toEqual(serverKey.uri);

      // A different key URI is a different server key: replacement.
      const replaced = yield* stack.deploy(program(password, 1));
      expect(replaced.serverKey.serverKeyName).not.toEqual(
        serverKey.serverKeyName,
      );
      expect(
        yield* awaitGone(
          getKey(
            group.resourceGroupName,
            server.serverName,
            serverKey.serverKeyName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* awaitGone(
          getKey(
            group.resourceGroupName,
            server.serverName,
            replaced.serverKey.serverKeyName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 900_000 },
);
