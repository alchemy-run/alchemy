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

const getAdministrator = (resourceGroupName: string, serverName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* sql.GetServerAzureADAdministrator({
      subscriptionId,
      resourceGroupName,
      serverName,
      administratorName: "ActiveDirectory",
    });
  });

const administratorGone = (resourceGroupName: string, serverName: string) =>
  getAdministrator(resourceGroupName, serverName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 20,
    }),
  );

const program = (props: {
  password: Redacted.Redacted<string>;
  admin: "First" | "Second";
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
    const first = yield* Azure.ManagedIdentity.UserAssignedIdentity("First", {
      resourceGroup: group.resourceGroupName,
    });
    const second = yield* Azure.ManagedIdentity.UserAssignedIdentity("Second", {
      resourceGroup: group.resourceGroupName,
    });
    const chosen = props.admin === "First" ? first : second;
    const admin = yield* Azure.Sql.ServerAzureADAdministrator("Admin", {
      resourceGroup: group.resourceGroupName,
      server: server.serverName,
      login: chosen.identityName,
      sid: chosen.clientId,
    });
    return { group, server, first, second, admin };
  });

test.provider(
  "set, change, and remove a sql server's entra administrator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = Redacted.make(
        `Az!${yield* Effect.sync(() => randomUUID())}`,
      );

      const { group, server, first, admin } = yield* stack.deploy(
        program({ password, admin: "First" }),
      );
      expect(admin.login).toEqual(first.identityName);
      expect(admin.sid.toLowerCase()).toEqual(first.clientId.toLowerCase());
      const observed = yield* getAdministrator(
        group.resourceGroupName,
        server.serverName,
      );
      expect(observed.properties?.sid?.toLowerCase()).toEqual(
        first.clientId.toLowerCase(),
      );

      // In place: switch to the second identity.
      const updated = yield* stack.deploy(
        program({ password, admin: "Second" }),
      );
      expect(updated.admin.administratorId).toEqual(admin.administratorId);
      const reobserved = yield* getAdministrator(
        group.resourceGroupName,
        server.serverName,
      );
      expect(reobserved.properties?.login).toEqual(updated.second.identityName);
      expect(reobserved.properties?.sid?.toLowerCase()).toEqual(
        updated.second.clientId.toLowerCase(),
      );

      // Removing the administrator from the stack deletes it while the
      // server stays.
      yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "centralus",
          });
          const server = yield* Azure.Sql.Server("Db", {
            resourceGroup: group.resourceGroupName,
            location: group.location,
            administratorLogin: "alchemyadmin",
            administratorLoginPassword: password,
          });
          return { group, server };
        }),
      );
      expect(
        yield* administratorGone(group.resourceGroupName, server.serverName),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:sql", "live"],
    timeout: 600_000,
  },
);
