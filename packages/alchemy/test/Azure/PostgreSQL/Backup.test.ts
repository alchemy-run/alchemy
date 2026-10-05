import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as postgresql from "@distilled.cloud/azure/postgresql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, serverRef, tags, testServer, untilGone } from "./server.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (name: string) =>
  Effect.gen(function* () {
    // On-demand backups are rejected on Burstable servers.
    const { group, server } = yield* testServer({
      sku: { name: "Standard_D2ds_v5", tier: "GeneralPurpose" },
    });
    const backup = yield* Azure.PostgreSQL.Backup("Snapshot", {
      resourceGroup: group.resourceGroupName,
      server: server.serverName,
      name,
    });
    return { group, server, backup };
  });

const getBackup = (
  resourceGroupName: string,
  serverName: string,
  backupName: string,
) =>
  Effect.gen(function* () {
    const ref = yield* serverRef(resourceGroupName, serverName);
    return yield* postgresql.GetBackupsAutomaticAndOnDemand({
      ...ref,
      backupName,
    });
  });

// One General Purpose D2ds_v5 server (≈ $0.18/h) for ~15 minutes ≈ $0.05;
// on-demand backup storage of an empty server is negligible.
test.provider(
  "take, replace, and delete an on-demand backup",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, server, backup } = yield* stack.deploy(
        program("snapshot-1"),
      );
      expect(backup.backupName).toEqual("snapshot-1");
      expect(backup.completedTime).toBeDefined();
      const observed = yield* getBackup(
        group.resourceGroupName,
        server.serverName,
        "snapshot-1",
      );
      expect(observed.properties?.backupType).toEqual("Customer On-Demand");

      // A new name takes a new backup and deletes the old one.
      const replaced = yield* stack.deploy(program("snapshot-2"));
      expect(replaced.backup.backupName).toEqual("snapshot-2");
      expect(
        yield* untilGone(
          getBackup(group.resourceGroupName, server.serverName, "snapshot-1"),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getBackup(group.resourceGroupName, server.serverName, "snapshot-2"),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 1_200_000 },
);
