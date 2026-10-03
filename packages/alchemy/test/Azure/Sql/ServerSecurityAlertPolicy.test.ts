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
  sqlServer,
  subscription,
} from "./harness.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSetting = (resourceGroupName: string, serverName: string) =>
  Effect.gen(function* () {
    return yield* sql.GetServerSecurityAlertPolicy({
      subscriptionId: yield* subscription,
      resourceGroupName,
      serverName,
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
    const { group, server } = yield* sqlServer(password);
    const setting =
      step === undefined
        ? undefined
        : yield* Azure.Sql.ServerSecurityAlertPolicy("Setting", {
            resourceGroup: group.resourceGroupName,
            server: server.serverName,
            ...step,
          });
    return { group, server, setting };
  });

// The server and these settings are free (Defender for SQL prorates to < $0.01 per run).
test.provider(
  "set, update, and reset a server security alert policy",
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
      const { group, server } = first;
      const get = getSetting(group.resourceGroupName, server.serverName);

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
