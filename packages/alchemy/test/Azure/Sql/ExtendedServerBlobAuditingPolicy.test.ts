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
    return yield* sql.GetExtendedServerBlobAuditingPolicy({
      subscriptionId: yield* subscription,
      resourceGroupName,
      serverName,
      blobAuditingPolicyName: "default",
    });
  });

type Step = {
  state: "Enabled" | "Disabled";
  isAzureMonitorTargetEnabled?: boolean;
  predicateExpression?: string;
};

const program = (password: Redacted.Redacted<string>, step: Step | undefined) =>
  Effect.gen(function* () {
    const { group, server } = yield* sqlServer(password);
    const setting =
      step === undefined
        ? undefined
        : yield* Azure.Sql.ExtendedServerBlobAuditingPolicy("Setting", {
            resourceGroup: group.resourceGroupName,
            server: server.serverName,
            ...step,
          });
    return { group, server, setting };
  });

// The server and these settings are free (Defender for SQL prorates to < $0.01 per run).
test.provider(
  "set, update, and reset an extended server auditing policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const first = yield* stack.deploy(
        program(password, {
          state: "Enabled",
          isAzureMonitorTargetEnabled: true,
          predicateExpression: "statement <> 'select 1'",
        }),
      );
      const { group, server } = first;
      const get = getSetting(group.resourceGroupName, server.serverName);

      const observed1 = yield* awaitObserved(
        get,
        (o) => o.properties?.state === "Enabled",
        12,
      );
      expect(observed1.properties?.predicateExpression).toEqual(
        "statement <> 'select 1'",
      );

      // In place update.
      const second = yield* stack.deploy(
        program(password, {
          state: "Enabled",
          isAzureMonitorTargetEnabled: true,
          predicateExpression: "statement <> 'select 2'",
        }),
      );
      expect(second.setting?.policyId).toEqual(first.setting?.policyId);
      const observed2 = yield* awaitObserved(
        get,
        (o) => o.properties?.predicateExpression === "statement <> 'select 2'",
        12,
      );
      expect(observed2.properties?.predicateExpression).toEqual(
        "statement <> 'select 2'",
      );

      // Removing the resource disables auditing.
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
