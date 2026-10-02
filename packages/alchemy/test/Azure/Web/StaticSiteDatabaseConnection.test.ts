import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const showConnection = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* web.GetStaticSiteDatabaseConnectionWithDetails({
      subscriptionId,
      resourceGroupName,
      name,
      databaseConnectionName: "default",
    });
  });

const connectionGone = (resourceGroupName: string, name: string) =>
  showConnection(resourceGroupName, name).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const adminPassword = "Az!alchemy-Test-0001";

const connectionString = (server: string, database: string, timeout: number) =>
  `Server=tcp:${server},1433;Database=${database};User ID=alchemyadmin;Password=${adminPassword};Encrypt=true;Connection Timeout=${timeout};`;

const program = (timeout: number | undefined) =>
  Effect.gen(function* () {
    // The free trial refuses new SQL servers in eastus (`ProvisioningDisabled`).
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "centralus",
    });
    const server = yield* Azure.Sql.Server("Db", {
      resourceGroup: group.resourceGroupName,
      location: group.location,
      administratorLogin: "alchemyadmin",
      administratorLoginPassword: Redacted.make(adminPassword),
    });
    const database = yield* Azure.Sql.Database("App", {
      resourceGroup: group.resourceGroupName,
      server: server.serverName,
      sku: { name: "Basic" },
      requestedBackupStorageRedundancy: "Local",
    });
    const site = yield* Azure.Web.StaticSite("Site", {
      resourceGroup: group.resourceGroupName,
      location: "centralus",
      sku: "Standard",
    });
    const connection =
      timeout === undefined
        ? undefined
        : yield* Azure.Web.StaticSiteDatabaseConnection("Data", {
            resourceGroup: group.resourceGroupName,
            staticSiteName: site.staticSiteName,
            resourceId: database.databaseId,
            region: group.location,
            connectionString: Output.interpolate`Server=tcp:${server.fullyQualifiedDomainName},1433;Database=${database.databaseName};User ID=alchemyadmin;Password=${adminPassword};Encrypt=true;Connection Timeout=${timeout};`,
          });
    return { group, server, database, site, connection };
  });

const reveal = (value: string | Redacted.Redacted<string> | undefined) =>
  value === undefined || typeof value === "string"
    ? value
    : Redacted.value(value);

// Cost: Basic SQL database ($4.90/month) + Standard static site ($9/month)
// for ~10 minutes: about $0.01. Provisioning: ~4-6 minutes (SQL server).
test.provider(
  "connect, update, and disconnect a static site database",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, server, database, site, connection } =
        yield* stack.deploy(program(30));
      expect(connection!.databaseConnectionName).toEqual("default");
      expect(connection!.resourceId.toLowerCase()).toEqual(
        database.databaseId.toLowerCase(),
      );
      const observed = yield* showConnection(
        group.resourceGroupName,
        site.staticSiteName,
      );
      expect(observed.properties?.resourceId.toLowerCase()).toEqual(
        database.databaseId.toLowerCase(),
      );
      expect(reveal(observed.properties?.connectionString)).toContain(
        "Connection Timeout=30",
      );

      // In-place update: the connection string.
      yield* stack.deploy(program(60));
      const updated = yield* showConnection(
        group.resourceGroupName,
        site.staticSiteName,
      );
      expect(reveal(updated.properties?.connectionString)).toEqual(
        connectionString(
          server.fullyQualifiedDomainName,
          database.databaseName,
          60,
        ),
      );

      // Delete only the connection.
      yield* stack.deploy(program(undefined));
      expect(
        yield* connectionGone(group.resourceGroupName, site.staticSiteName),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 900_000,
  },
);
