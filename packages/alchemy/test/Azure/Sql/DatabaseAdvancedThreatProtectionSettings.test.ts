import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as sql from "@distilled.cloud/azure/sql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import {
  awaitGone,
  awaitObserved,
  logLevel,
  newPassword,
  SQL_TAGS,
  sqlDatabase,
  subscription,
} from "./harness.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSetting = (
  resourceGroupName: string,
  serverName: string,
  databaseName: string,
) =>
  Effect.gen(function* () {
    return yield* sql.GetDatabaseAdvancedThreatProtectionSettings({
      subscriptionId: yield* subscription,
      resourceGroupName,
      serverName,
      databaseName,
      advancedThreatProtectionName: "Default",
    });
  });

type Step = { state: "Enabled" | "Disabled" };

const program = (password: Redacted.Redacted<string>, step: Step | undefined) =>
  Effect.gen(function* () {
    const { group, server, database } = yield* sqlDatabase(password);
    const setting =
      step === undefined
        ? undefined
        : yield* Azure.Sql.DatabaseAdvancedThreatProtectionSettings("Setting", {
            resourceGroup: group.resourceGroupName,
            server: server.serverName,
            database: database.databaseName,
            ...step,
          });
    return { group, server, database, setting };
  });

// A Basic database (~$0.007/hour) for ~5 minutes; the settings are free (Defender for SQL prorates to < $0.01).
test.provider(
  "set, update, and reset database advanced threat protection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const first = yield* stack.deploy(
        program(password, { state: "Disabled" }),
      );
      const { group, server, database } = first;
      const get = getSetting(
        group.resourceGroupName,
        server.serverName,
        database.databaseName,
      );

      const observed1 = yield* awaitObserved(
        get,
        (o) => o.properties?.state === "Disabled",
        12,
      );
      expect(observed1.properties?.state).toEqual("Disabled");

      // In place update.
      const second = yield* stack.deploy(
        program(password, { state: "Enabled" }),
      );
      expect(second.setting?.settingId).toEqual(first.setting?.settingId);
      const observed2 = yield* awaitObserved(
        get,
        (o) => o.properties?.state === "Enabled",
        12,
      );
      expect(observed2.properties?.state).toEqual("Enabled");

      // Removing the resource disables protection.
      yield* stack.deploy(program(password, undefined));
      expect(
        (yield* awaitObserved(
          get,
          (o) => o.properties?.state === "Disabled",
          12,
        )).properties?.state,
      ).toEqual("Disabled");

      yield* stack.destroy();
      expect(yield* awaitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 900_000 },
);
