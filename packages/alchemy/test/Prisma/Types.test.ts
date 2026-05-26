import type {
  Database,
  DatabaseConnectionWithSecrets,
  DatabaseSourceInput,
} from "@/Prisma/Types";
import { describe, expect, it } from "@effect/vitest";

const nullableDatabaseSource: Database["source"] = null;
const endpointSecretMayBeAbsent: DatabaseConnectionWithSecrets["endpoints"] = {
  direct: {
    host: "db.prisma.test",
    port: 5432,
  },
};
const validDatabaseSourceInput: DatabaseSourceInput = {
  type: "backup",
  databaseId: "db_source",
  backupId: "backup_1",
};
// @ts-expect-error Prisma only accepts the documented source discriminator.
const invalidDatabaseSourceInput: DatabaseSourceInput = { type: "snapshot" };

describe("Prisma API types", () => {
  it("mirror nullable database sources and optional create-time secrets", () => {
    expect(nullableDatabaseSource).toBeNull();
    expect(endpointSecretMayBeAbsent.direct?.connectionString).toBeUndefined();
    expect(validDatabaseSourceInput.type).toBe("backup");
    expect(invalidDatabaseSourceInput.type).toBe("snapshot");
  });
});
