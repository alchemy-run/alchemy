import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as postgresql from "@distilled.cloud/azure/postgresql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, serverRef, tags, testServer, untilGone } from "./server.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (collation: string) =>
  Effect.gen(function* () {
    const { group, server } = yield* testServer();
    const database = yield* Azure.PostgreSQL.Database("App", {
      resourceGroup: group.resourceGroupName,
      server: server.serverName,
      collation,
    });
    return { group, server, database };
  });

const getDatabase = (
  resourceGroupName: string,
  serverName: string,
  databaseName: string,
) =>
  Effect.gen(function* () {
    const ref = yield* serverRef(resourceGroupName, serverName);
    return yield* postgresql.GetDatabase({ ...ref, databaseName });
  });

// One Burstable B1ms server (≈ $0.02/h) for ~10 minutes.
test.provider(
  "create, replace, and delete a database",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, server, database } = yield* stack.deploy(
        program("en_US.utf8"),
      );
      expect(database.databaseName).toMatch(/^[a-z0-9_]+$/);
      expect(database.server).toEqual(server.serverName);
      const observed = yield* getDatabase(
        group.resourceGroupName,
        server.serverName,
        database.databaseName,
      );
      expect(observed.properties?.charset).toEqual("UTF8");
      expect(observed.properties?.collation).toEqual("en_US.utf8");

      // Collation is immutable: changing it replaces the database.
      const replaced = yield* stack.deploy(program("C"));
      expect(replaced.database.databaseName).not.toEqual(database.databaseName);
      const reobserved = yield* getDatabase(
        group.resourceGroupName,
        server.serverName,
        replaced.database.databaseName,
      );
      expect(reobserved.properties?.collation).toEqual("C");
      expect(
        yield* untilGone(
          getDatabase(
            group.resourceGroupName,
            server.serverName,
            database.databaseName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getDatabase(
            group.resourceGroupName,
            server.serverName,
            replaced.database.databaseName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 1_200_000 },
);
