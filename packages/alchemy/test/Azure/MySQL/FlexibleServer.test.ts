import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as mysql from "@distilled.cloud/azure/mysql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { runExpensive } from "../gates.ts";
import {
  logLevel,
  MYSQL_TEST_LOCATION,
  serverRef,
  tags,
  untilGone,
} from "./server.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getServer = (resourceGroupName: string, serverName: string) =>
  Effect.gen(function* () {
    const ref = yield* serverRef(resourceGroupName, serverName);
    return yield* mysql.GetServer(ref);
  });

const program = (props: {
  backupRetentionDays: number;
  tags: Record<string, string>;
  administratorLogin?: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const server = yield* Azure.MySQL.FlexibleServer("Db", {
      resourceGroup: group.resourceGroupName,
      location: MYSQL_TEST_LOCATION,
      backup: { backupRetentionDays: props.backupRetentionDays },
      administratorLogin: props.administratorLogin,
      tags: props.tags,
    });
    return { group, server };
  });

// Burstable B1ms + 20 GiB ≈ $0.02/h; create 4-8 min, delete 2-5 min.
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
      expect(server.version).toEqual("8.0.21");
      expect(server.administratorLogin).toEqual("alchemyadmin");
      expect(server.fullyQualifiedDomainName).toEqual(
        `${server.serverName}.mysql.database.azure.com`,
      );
      expect(server.administratorLoginPassword).toBeDefined();
      expect(Redacted.value(server.connectionString!)).toContain(
        `@${server.fullyQualifiedDomainName}:3306/`,
      );

      const observed = yield* getServer(
        group.resourceGroupName,
        server.serverName,
      );
      expect(observed.properties?.state).toEqual("Ready");
      expect(observed.sku?.tier).toEqual("Burstable");
      expect(observed.properties?.storage?.storageSizeGB).toEqual(20);
      expect(observed.properties?.backup?.backupRetentionDays).toEqual(7);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Db");

      // In-place update: backup retention and tags.
      const updated = yield* stack.deploy(
        program({ backupRetentionDays: 10, tags: { env: "prod" } }),
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
      expect(reobserved.properties?.backup?.backupRetentionDays).toEqual(10);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(getServer(group.resourceGroupName, server.serverName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
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
        yield* untilGone(getServer(group.resourceGroupName, server.serverName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getServer(group.resourceGroupName, replaced.server.serverName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
