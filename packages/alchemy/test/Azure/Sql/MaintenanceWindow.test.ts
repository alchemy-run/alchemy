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
    return yield* sql.GetMaintenanceWindows({
      subscriptionId: yield* subscription,
      resourceGroupName,
      serverName,
      databaseName,
      maintenanceWindowName: "current",
    });
  });

type Step = {
  timeRanges: {
    dayOfWeek: "Saturday" | "Sunday";
    startTime: string;
    duration: string;
  }[];
};

const program = (password: Redacted.Redacted<string>, step: Step | undefined) =>
  Effect.gen(function* () {
    const { group, server, database } = yield* sqlDatabase(password, {
      sku: { name: "GP_Gen5_2" },
    });
    const setting =
      step === undefined
        ? undefined
        : yield* Azure.Sql.MaintenanceWindow("Setting", {
            resourceGroup: group.resourceGroupName,
            server: server.serverName,
            database: database.databaseName,
            ...step,
          });
    return { group, server, database, setting };
  });

// A Basic database rejects custom windows ("Invalid maintenance window selection.")
// and its GET answers InternalServerError. A General Purpose Gen5 2 vCore
// database (~$0.50/hour) for ~15 minutes: about $0.15 per run, but valid
// windows are region/offer specific, so it only runs with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "set, update, and clear a database maintenance window",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const first = yield* stack.deploy(
        program(password, {
          timeRanges: [
            { dayOfWeek: "Saturday", startTime: "22:00:00", duration: "PT8H" },
          ],
        }),
      );
      const { group, server, database } = first;
      const get = getSetting(
        group.resourceGroupName,
        server.serverName,
        database.databaseName,
      );

      const observed1 = yield* awaitObserved(
        get,
        (o) => o.properties?.timeRanges?.[0]?.dayOfWeek === "Saturday",
        12,
      );
      expect(observed1.properties?.timeRanges?.[0]?.startTime).toEqual(
        "22:00:00",
      );

      // In place update.
      const second = yield* stack.deploy(
        program(password, {
          timeRanges: [
            { dayOfWeek: "Sunday", startTime: "22:00:00", duration: "PT8H" },
          ],
        }),
      );
      expect(second.setting?.settingId).toEqual(first.setting?.settingId);
      const observed2 = yield* awaitObserved(
        get,
        (o) => o.properties?.timeRanges?.[0]?.dayOfWeek === "Sunday",
        12,
      );
      expect(observed2.properties?.timeRanges?.[0]?.dayOfWeek).toEqual(
        "Sunday",
      );

      // Removing the resource clears the custom windows.
      yield* stack.deploy(program(password, undefined));
      expect(
        (yield* awaitObserved(
          get,
          (o) => (o.properties?.timeRanges ?? []).length === 0,
          12,
        )).properties?.timeRanges ?? [],
      ).toEqual([]);

      yield* stack.destroy();
      expect(yield* awaitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 900_000 },
);
