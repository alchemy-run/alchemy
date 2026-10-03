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

const getServer = (resourceGroupName: string, serverName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* sql.GetServer({
      subscriptionId,
      resourceGroupName,
      serverName,
    });
  });

const serverGone = (resourceGroupName: string, serverName: string) =>
  getServer(resourceGroupName, serverName).pipe(
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
  administratorLogin: string;
  password: Redacted.Redacted<string>;
  publicNetworkAccess: "Enabled" | "Disabled";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    // The free trial refuses new SQL servers in eastus/eastus2/westus2
    // (`ProvisioningDisabled`); centralus accepts them.
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "centralus",
    });
    const server = yield* Azure.Sql.Server("Db", {
      resourceGroup: group.resourceGroupName,
      location: group.location,
      administratorLogin: props.administratorLogin,
      administratorLoginPassword: props.password,
      publicNetworkAccess: props.publicNetworkAccess,
      tags: props.tags,
    });
    return { group, server };
  });

test.provider(
  "create, update, replace, and delete a sql server",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = Redacted.make(
        `Az!${yield* Effect.sync(() => randomUUID())}`,
      );

      const { group, server } = yield* stack.deploy(
        program({
          administratorLogin: "alchemyadmin",
          password,
          publicNetworkAccess: "Enabled",
          tags: { env: "test" },
        }),
      );
      expect(server.serverName).toMatch(/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/);
      expect(server.fullyQualifiedDomainName).toEqual(
        `${server.serverName}.database.windows.net`,
      );
      expect(server.administratorLogin).toEqual("alchemyadmin");
      expect(server.tags).toEqual({ env: "test" });
      const observed = yield* getServer(
        group.resourceGroupName,
        server.serverName,
      );
      expect(observed.properties?.state).toEqual("Ready");
      expect(observed.properties?.minimalTlsVersion).toEqual("1.2");
      expect(observed.properties?.publicNetworkAccess).toEqual("Enabled");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Db");

      // In place: public network access and tags.
      const updated = yield* stack.deploy(
        program({
          administratorLogin: "alchemyadmin",
          password,
          publicNetworkAccess: "Disabled",
          tags: { env: "prod" },
        }),
      );
      expect(updated.server.serverName).toEqual(server.serverName);
      const reobserved = yield* getServer(
        group.resourceGroupName,
        server.serverName,
      );
      expect(reobserved.properties?.publicNetworkAccess).toEqual("Disabled");
      expect(reobserved.tags?.env).toEqual("prod");

      // The administrator login is immutable: changing it replaces the server.
      const replaced = yield* stack.deploy(
        program({
          administratorLogin: "alchemyadmin2",
          password,
          publicNetworkAccess: "Disabled",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.server.serverName).not.toEqual(server.serverName);
      expect(replaced.server.administratorLogin).toEqual("alchemyadmin2");
      expect(
        yield* serverGone(group.resourceGroupName, server.serverName),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* serverGone(group.resourceGroupName, replaced.server.serverName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:sql", "live"],
    timeout: 600_000,
  },
);
