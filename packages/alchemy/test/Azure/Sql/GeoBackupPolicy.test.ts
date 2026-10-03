import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as sql from "@distilled.cloud/azure/sql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { runExpensive } from "../gates.ts";
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
    return yield* sql.GetGeoBackupPolicy({
      subscriptionId: yield* subscription,
      resourceGroupName,
      serverName,
      databaseName,
      geoBackupPolicyName: "Default",
    });
  });

type Step = { state: "Enabled" | "Disabled" };

const program = (password: Redacted.Redacted<string>, step: Step | undefined) =>
  Effect.gen(function* () {
    const { group, server, database } = yield* sqlDatabase(password, {
      sku: { name: "DW100c" },
      requestedBackupStorageRedundancy: undefined,
    });
    const setting =
      step === undefined
        ? undefined
        : yield* Azure.Sql.GeoBackupPolicy("Setting", {
            resourceGroup: group.resourceGroupName,
            server: server.serverName,
            database: database.databaseName,
            ...step,
          });
    return { group, server, database, setting };
  });

// Geo-backup policies only apply to dedicated SQL pools (a Basic database answers
// InternalServerError). A DW100c pool costs ~$1.20/hour and takes 5-10 minutes to
// provision: about $0.40 per run, so it only runs with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "set, update, and reset a geo backup policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const first = yield* stack.deploy(
        program(password, { state: "Enabled" }),
      );
      const { group, server, database } = first;
      const get = getSetting(
        group.resourceGroupName,
        server.serverName,
        database.databaseName,
      );

      const observed1 = yield* awaitObserved(
        get,
        (o) => o.properties?.state === "Enabled",
        12,
      );
      expect(observed1.properties?.state).toEqual("Enabled");

      // In place update.
      const second = yield* stack.deploy(
        program(password, { state: "Disabled" }),
      );
      expect(second.setting?.policyId).toEqual(first.setting?.policyId);
      const observed2 = yield* awaitObserved(
        get,
        (o) => o.properties?.state === "Disabled",
        12,
      );
      expect(observed2.properties?.state).toEqual("Disabled");

      // Removing the resource re-enables geo backups.
      yield* stack.deploy(program(password, undefined));
      expect(
        (yield* awaitObserved(
          get,
          (o) => o.properties?.state === "Enabled",
          12,
        )).properties?.state,
      ).toEqual("Enabled");

      yield* stack.destroy();
      expect(yield* awaitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 900_000 },
);
