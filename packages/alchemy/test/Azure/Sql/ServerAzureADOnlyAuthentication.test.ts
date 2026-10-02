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

const getSetting = (resourceGroupName: string, serverName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* sql.GetServerAzureADOnlyAuthentication({
      subscriptionId,
      resourceGroupName,
      serverName,
      authenticationName: "Default",
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

const program = (props: {
  password: Redacted.Redacted<string>;
  entraOnly: boolean | undefined;
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
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity(
      "Admin",
      { resourceGroup: group.resourceGroupName },
    );
    const admin = yield* Azure.Sql.ServerAzureADAdministrator("Admin", {
      resourceGroup: group.resourceGroupName,
      server: server.serverName,
      login: identity.identityName,
      sid: identity.clientId,
    });
    const entraOnly =
      props.entraOnly === undefined
        ? undefined
        : yield* Azure.Sql.ServerAzureADOnlyAuthentication("EntraOnly", {
            resourceGroup: group.resourceGroupName,
            // Depend on the administrator so the setting is reset first.
            server: admin.serverName,
            azureADOnlyAuthentication: props.entraOnly,
          });
    return { group, server, entraOnly };
  });

test.provider(
  "enable, disable, and reset entra-only authentication on a sql server",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = Redacted.make(
        `Az!${yield* Effect.sync(() => randomUUID())}`,
      );

      const { group, server, entraOnly } = yield* stack.deploy(
        program({ password, entraOnly: true }),
      );
      expect(entraOnly?.azureADOnlyAuthentication).toEqual(true);
      const observed = yield* getSetting(
        group.resourceGroupName,
        server.serverName,
      );
      expect(observed.properties?.azureADOnlyAuthentication).toEqual(true);

      // In place: allow SQL authentication again.
      const disabled = yield* stack.deploy(
        program({ password, entraOnly: false }),
      );
      expect(disabled.entraOnly?.authenticationId).toEqual(
        entraOnly?.authenticationId,
      );
      expect(
        (yield* getSetting(group.resourceGroupName, server.serverName))
          .properties?.azureADOnlyAuthentication,
      ).toEqual(false);

      // In place: enforce it again.
      yield* stack.deploy(program({ password, entraOnly: true }));
      expect(
        (yield* getSetting(group.resourceGroupName, server.serverName))
          .properties?.azureADOnlyAuthentication,
      ).toEqual(true);

      // Removing the resource resets the singleton to `false`.
      yield* stack.deploy(program({ password, entraOnly: undefined }));
      expect(
        (yield* getSetting(group.resourceGroupName, server.serverName))
          .properties?.azureADOnlyAuthentication,
      ).toEqual(false);

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
