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
    return yield* sql.GetDataMaskingPolicy({
      subscriptionId: yield* subscription,
      resourceGroupName,
      serverName,
      databaseName,
      dataMaskingPolicyName: "Default",
    });
  });

type Step = {
  dataMaskingState: "Enabled" | "Disabled";
  exemptPrincipals?: string;
};

const program = (password: Redacted.Redacted<string>, step: Step | undefined) =>
  Effect.gen(function* () {
    const { group, server, database } = yield* sqlDatabase(password);
    const setting =
      step === undefined
        ? undefined
        : yield* Azure.Sql.DataMaskingPolicy("Setting", {
            resourceGroup: group.resourceGroupName,
            server: server.serverName,
            database: database.databaseName,
            ...step,
          });
    return { group, server, database, setting };
  });

// A Basic database (~$0.007/hour) for ~5 minutes; the settings are free (Defender for SQL prorates to < $0.01).
test.provider(
  "set, update, and reset a data masking policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const first = yield* stack.deploy(
        program(password, {
          dataMaskingState: "Enabled",
          exemptPrincipals: "reporting",
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
        (o) => o.properties?.dataMaskingState === "Enabled",
        12,
      );
      expect(observed1.properties?.exemptPrincipals).toEqual("reporting");

      // In place update.
      const second = yield* stack.deploy(
        program(password, {
          dataMaskingState: "Enabled",
          exemptPrincipals: "reporting;analyst",
        }),
      );
      expect(second.setting?.policyId).toEqual(first.setting?.policyId);
      const observed2 = yield* awaitObserved(
        get,
        (o) => o.properties?.exemptPrincipals === "reporting;analyst",
        12,
      );
      expect(observed2.properties?.exemptPrincipals).toEqual(
        "reporting;analyst",
      );

      // Removing the resource disables masking.
      yield* stack.deploy(program(password, undefined));
      expect(
        (yield* awaitObserved(
          get,
          (o) => o.properties?.dataMaskingState === "Disabled",
          12,
        )).properties?.dataMaskingState,
      ).toEqual("Disabled");

      yield* stack.destroy();
      expect(yield* awaitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 900_000 },
);
