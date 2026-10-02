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

const getPolicy = (resourceGroupName: string, serverName: string) =>
  Effect.gen(function* () {
    return yield* sql.GetServerConnectionPolicy({
      subscriptionId: yield* subscription,
      resourceGroupName,
      serverName,
      connectionPolicyName: "default",
    });
  });

const program = (
  password: Redacted.Redacted<string>,
  connectionType: "Proxy" | "Redirect" | undefined,
) =>
  Effect.gen(function* () {
    const { group, server } = yield* sqlServer(password);
    const policy =
      connectionType === undefined
        ? undefined
        : yield* Azure.Sql.ServerConnectionPolicy("Connection", {
            resourceGroup: group.resourceGroupName,
            server: server.serverName,
            connectionType,
          });
    return { group, server, policy };
  });

// The server and the policy are free.
test.provider(
  "set, update, and reset a sql server connection policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const { group, server, policy } = yield* stack.deploy(
        program(password, "Proxy"),
      );
      expect(policy?.connectionType).toEqual("Proxy");
      expect(
        (yield* getPolicy(group.resourceGroupName, server.serverName))
          .properties?.connectionType,
      ).toEqual("Proxy");

      // In place: switch to Redirect.
      const updated = yield* stack.deploy(program(password, "Redirect"));
      expect(updated.policy?.policyId).toEqual(policy?.policyId);
      expect(
        (yield* getPolicy(group.resourceGroupName, server.serverName))
          .properties?.connectionType,
      ).toEqual("Redirect");

      // Removing the resource resets the policy.
      yield* stack.deploy(program(password, undefined));
      expect(
        (yield* getPolicy(group.resourceGroupName, server.serverName))
          .properties?.connectionType,
      ).toEqual("Default");

      yield* stack.destroy();
      expect(
        yield* awaitGone(getPolicy(group.resourceGroupName, server.serverName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 900_000 },
);
