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
    return yield* sql.GetDatabaseSecurityAlertPolicy({
      subscriptionId: yield* subscription,
      resourceGroupName,
      serverName,
      databaseName,
      securityAlertPolicyName: "Default",
    });
  });

type Step = {
  state: "Enabled" | "Disabled";
  emailAddresses?: string[];
  disabledAlerts?: string[];
};

const program = (password: Redacted.Redacted<string>, step: Step | undefined) =>
  Effect.gen(function* () {
    const { group, server, database } = yield* sqlDatabase(password);
    const setting =
      step === undefined
        ? undefined
        : yield* Azure.Sql.DatabaseSecurityAlertPolicy("Setting", {
            resourceGroup: group.resourceGroupName,
            server: server.serverName,
            database: database.databaseName,
            ...step,
          });
    return { group, server, database, setting };
  });

// A Basic database (~$0.007/hour) for ~5 minutes; the settings are free (Defender for SQL prorates to < $0.01).
test.provider(
  "set, update, and reset a database security alert policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const first = yield* stack.deploy(
        program(password, {
          state: "Enabled",
          emailAddresses: ["alerts@example.com"],
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
        (o) => o.properties?.state === "Enabled",
        12,
      );
      expect(observed1.properties?.emailAddresses).toEqual([
        "alerts@example.com",
      ]);

      // In place update.
      const second = yield* stack.deploy(
        program(password, {
          state: "Enabled",
          emailAddresses: ["security@example.com"],
          disabledAlerts: ["Access_Anomaly"],
        }),
      );
      expect(second.setting?.policyId).toEqual(first.setting?.policyId);
      const observed2 = yield* awaitObserved(
        get,
        (o) => o.properties?.emailAddresses?.[0] === "security@example.com",
        12,
      );
      expect(observed2.properties?.emailAddresses).toEqual([
        "security@example.com",
      ]);
      expect(observed2.properties?.disabledAlerts).toEqual(["Access_Anomaly"]);

      // Removing the resource disables the alerts.
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
