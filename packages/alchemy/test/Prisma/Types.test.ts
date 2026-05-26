import type { Database, DatabaseConnectionWithSecrets } from "@/Prisma/Types";
import { describe, expect, it } from "@effect/vitest";

const nullableDatabaseSource: Database["source"] = null;
const endpointSecretMayBeAbsent: DatabaseConnectionWithSecrets["endpoints"] = {
  direct: {
    host: "db.prisma.test",
    port: 5432,
  },
};

describe("Prisma API types", () => {
  it("mirror nullable database sources and optional create-time secrets", () => {
    expect(nullableDatabaseSource).toBeNull();
    expect(endpointSecretMayBeAbsent.direct?.connectionString).toBeUndefined();
  });
});
