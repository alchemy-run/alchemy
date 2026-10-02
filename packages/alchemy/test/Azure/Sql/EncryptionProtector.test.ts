import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as sql from "@distilled.cloud/azure/sql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { cmkServer } from "./cmk.ts";
import {
  awaitGone,
  awaitObserved,
  logLevel,
  newPassword,
  SQL_TAGS,
  subscription,
} from "./harness.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getProtector = (resourceGroupName: string, serverName: string) =>
  Effect.gen(function* () {
    return yield* sql.GetEncryptionProtector({
      subscriptionId: yield* subscription,
      resourceGroupName,
      serverName,
      encryptionProtectorName: "current",
    });
  });

const program = (
  password: Redacted.Redacted<string>,
  protector: { autoRotationEnabled: boolean } | undefined,
) =>
  Effect.gen(function* () {
    const { group, server, keys } = yield* cmkServer(password, ["Tde"]);
    const serverKey = yield* Azure.Sql.ServerKey("TdeKey", {
      resourceGroup: group.resourceGroupName,
      server: server.serverName,
      uri: keys[0]!.keyUriWithVersion,
    });
    const encryption =
      protector === undefined
        ? undefined
        : yield* Azure.Sql.EncryptionProtector("Protector", {
            resourceGroup: group.resourceGroupName,
            server: server.serverName,
            serverKeyType: "AzureKeyVault",
            serverKeyName: serverKey.serverKeyName,
            autoRotationEnabled: protector.autoRotationEnabled,
          });
    return { group, server, serverKey, encryption };
  });

// Server, standard Key Vault, and one RSA key: < $0.01 per run.
test.provider(
  "switch a sql server to a customer-managed tde key and back",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const { group, server, serverKey, encryption } = yield* stack.deploy(
        program(password, { autoRotationEnabled: false }),
      );
      expect(encryption?.serverKeyType).toEqual("AzureKeyVault");
      const get = getProtector(group.resourceGroupName, server.serverName);
      const observed = yield* get;
      expect(observed.properties?.serverKeyName).toEqual(
        serverKey.serverKeyName,
      );
      expect(observed.properties?.autoRotationEnabled).toEqual(false);

      // In place: turn on automatic key rotation.
      yield* stack.deploy(program(password, { autoRotationEnabled: true }));
      expect(
        (yield* awaitObserved(
          get,
          (p) => p.properties?.autoRotationEnabled === true,
          12,
        )).properties?.autoRotationEnabled,
      ).toEqual(true);

      // Removing the protector switches back to the service-managed key.
      yield* stack.deploy(program(password, undefined));
      expect(
        (yield* awaitObserved(
          get,
          (p) => p.properties?.serverKeyType === "ServiceManaged",
          12,
        )).properties?.serverKeyType,
      ).toEqual("ServiceManaged");

      yield* stack.destroy();
      expect(yield* awaitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 900_000 },
);
