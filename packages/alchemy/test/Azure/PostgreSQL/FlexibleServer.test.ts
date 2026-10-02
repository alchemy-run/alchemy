import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as postgresql from "@distilled.cloud/azure/postgresql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";
import { logLevel, POSTGRES_TEST_LOCATION, tags } from "./server.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getServer = (resourceGroupName: string, serverName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* postgresql.GetServer({
      subscriptionId,
      resourceGroupName,
      serverName,
    });
  });

const serverGone = (resourceGroupName: string, serverName: string) =>
  getServer(resourceGroupName, serverName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times: 30,
    }),
  );

const program = (props: {
  backupRetentionDays: number;
  tags: Record<string, string>;
  administratorLogin?: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const server = yield* Azure.PostgreSQL.FlexibleServer("Db", {
      resourceGroup: group.resourceGroupName,
      location: POSTGRES_TEST_LOCATION,
      version: "16",
      backup: { backupRetentionDays: props.backupRetentionDays },
      administratorLogin: props.administratorLogin,
      tags: props.tags,
    });
    return { group, server };
  });

// Burstable B1ms + 32 GiB ≈ $0.02/h; create 4-8 min, delete 2-5 min.
test.provider(
  "create, update, and delete a burstable flexible server",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, server } = yield* stack.deploy(
        program({ backupRetentionDays: 7, tags: { env: "test" } }),
      );
      expect(server.serverName).toMatch(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
      expect(server.state).toEqual("Ready");
      expect(server.skuName).toEqual("Standard_B1ms");
      expect(server.version).toEqual("16");
      expect(server.administratorLogin).toEqual("alchemyadmin");
      expect(server.fullyQualifiedDomainName).toEqual(
        `${server.serverName}.postgres.database.azure.com`,
      );
      expect(server.administratorLoginPassword).toBeDefined();
      expect(Redacted.value(server.connectionString!)).toContain(
        `@${server.fullyQualifiedDomainName}:5432/postgres`,
      );

      const observed = yield* getServer(
        group.resourceGroupName,
        server.serverName,
      );
      expect(observed.properties?.state).toEqual("Ready");
      expect(observed.sku?.tier).toEqual("Burstable");
      expect(observed.properties?.storage?.storageSizeGB).toEqual(32);
      expect(observed.properties?.backup?.backupRetentionDays).toEqual(7);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Db");

      // In-place update: backup retention and tags.
      const updated = yield* stack.deploy(
        program({ backupRetentionDays: 14, tags: { env: "prod" } }),
      );
      expect(updated.server.serverName).toEqual(server.serverName);
      // The generated password survives updates.
      expect(
        Redacted.value(updated.server.administratorLoginPassword!),
      ).toEqual(Redacted.value(server.administratorLoginPassword!));
      const reobserved = yield* getServer(
        group.resourceGroupName,
        server.serverName,
      );
      expect(reobserved.properties?.backup?.backupRetentionDays).toEqual(14);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* serverGone(group.resourceGroupName, server.serverName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags,
    timeout: 1_200_000,
  },
);

// Replacement creates a second server: ~$0.02/h but ~15 min end to end,
// beyond the 10-minute budget for ungated tests.
test.provider.skipIf(!runExpensive)(
  "changing the administrator login replaces the server",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, server } = yield* stack.deploy(
        program({ backupRetentionDays: 7, tags: {} }),
      );
      const replaced = yield* stack.deploy(
        program({
          backupRetentionDays: 7,
          tags: {},
          administratorLogin: "alchemyowner",
        }),
      );
      expect(replaced.server.serverName).not.toEqual(server.serverName);
      expect(replaced.server.administratorLogin).toEqual("alchemyowner");
      expect(
        yield* serverGone(group.resourceGroupName, server.serverName),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* serverGone(group.resourceGroupName, replaced.server.serverName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags,
    timeout: 1_800_000,
  },
);
