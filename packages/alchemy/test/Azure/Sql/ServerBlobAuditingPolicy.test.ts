import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as sql from "@distilled.cloud/azure/sql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { randomUUID } from "node:crypto";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getPolicy = (resourceGroupName: string, serverName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* sql.GetServerBlobAuditingPolicy({
      subscriptionId,
      resourceGroupName,
      serverName,
      blobAuditingPolicyName: "default",
    });
  });

const serverGone = (resourceGroupName: string, serverName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* sql.GetServer({
      subscriptionId,
      resourceGroupName,
      serverName,
    });
  }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

const AUTH_GROUPS = [
  "SUCCESSFUL_DATABASE_AUTHENTICATION_GROUP",
  "FAILED_DATABASE_AUTHENTICATION_GROUP",
];

const program = (props: {
  password: Redacted.Redacted<string>;
  groups: string[] | undefined;
}) =>
  Effect.gen(function* () {
    // The free trial refuses new SQL servers in eastus (`ProvisioningDisabled`).
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "centralus",
    });
    const server = yield* Azure.Sql.Server("Db", {
      resourceGroup: group.resourceGroupName,
      location: group.location,
      administratorLogin: "alchemyadmin",
      administratorLoginPassword: props.password,
    });
    const policy =
      props.groups === undefined
        ? undefined
        : yield* Azure.Sql.ServerBlobAuditingPolicy("Audit", {
            resourceGroup: group.resourceGroupName,
            server: server.serverName,
            state: "Enabled",
            isAzureMonitorTargetEnabled: true,
            auditActionsAndGroups: props.groups,
          });
    return { group, server, policy };
  });

test.provider(
  "enable, update, and disable server auditing to azure monitor",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = Redacted.make(
        `Az!${yield* Effect.sync(() => randomUUID())}`,
      );

      const { group, server, policy } = yield* stack.deploy(
        program({ password, groups: AUTH_GROUPS }),
      );
      expect(policy?.state).toEqual("Enabled");
      const observed = yield* getPolicy(
        group.resourceGroupName,
        server.serverName,
      );
      expect(observed.properties?.state).toEqual("Enabled");
      expect(observed.properties?.isAzureMonitorTargetEnabled).toEqual(true);
      expect(
        [...(observed.properties?.auditActionsAndGroups ?? [])].sort(),
      ).toEqual([...AUTH_GROUPS].sort());

      // In place: audit only failed logins.
      yield* stack.deploy(
        program({ password, groups: ["FAILED_DATABASE_AUTHENTICATION_GROUP"] }),
      );
      const reobserved = yield* getPolicy(
        group.resourceGroupName,
        server.serverName,
      );
      expect(reobserved.properties?.auditActionsAndGroups).toEqual([
        "FAILED_DATABASE_AUTHENTICATION_GROUP",
      ]);

      // Removing the resource disables auditing again.
      yield* stack.deploy(program({ password, groups: undefined }));
      expect(
        (yield* getPolicy(group.resourceGroupName, server.serverName))
          .properties?.state,
      ).toEqual("Disabled");

      yield* stack.destroy();
      expect(
        yield* serverGone(group.resourceGroupName, server.serverName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:sql", "live"],
    timeout: 600_000,
  },
);
