import * as Azure from "@alchemy.run/azure";
import * as postgresql from "@distilled.cloud/azure/postgresql";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
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

const getBackup = (resourceGroupName: string, serverName: string, backupName: string) =>
  Effect.gen(function* () {
    const ref = yield* serverRef(resourceGroupName, serverName);
    return yield* postgresql.GetBackupsAutomaticAndOnDemand({
      ...ref,
      backupName,
    });
  });

// ~$0.05/run, 16 min: one General Purpose D2ds_v5 server (≈ $0.18/h) takes
// ~6 min to create and each on-demand backup 2-7 min. Backup storage of an
// empty server is negligible.
test.provider.skipIf(!runExpensive)(
  "take, replace, and delete an on-demand backup",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, server, backup } = yield* stack.deploy(program("snapshot-1"));
      expect(backup.backupName).toEqual("snapshot-1");
      expect(Number.isNaN(Date.parse(backup.completedTime ?? ""))).toBe(false);
      const observed = yield* getBackup(group.resourceGroupName, server.serverName, "snapshot-1");
      expect(observed.properties?.backupType).toEqual("Customer On-Demand");

      // A new name takes a new backup and deletes the old one.
      const replaced = yield* stack.deploy(program("snapshot-2"));
      expect(replaced.backup.backupName).toEqual("snapshot-2");
      expect(
        yield* untilGone(getBackup(group.resourceGroupName, server.serverName, "snapshot-1")),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* untilGone(getBackup(group.resourceGroupName, server.serverName, "snapshot-2")),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 2_100_000 },
);
