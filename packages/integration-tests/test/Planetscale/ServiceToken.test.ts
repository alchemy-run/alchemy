import * as Planetscale from "@alchemy.run/planetscale";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ps from "@distilled.cloud/planetscale";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Planetscale.providers() });

// Use an existing test database: service-token lifecycle needs no new database.
describe.skipIf(!process.env.PLANETSCALE_TEST || !process.env.PLANETSCALE_SERVICE_TOKEN_DATABASE)(
  "ServiceToken",
  { tags: ["provider:planetscale", "live"] },
  () => {
    test.provider(
      "retains secrets, converges grants, recovers deletion, and replaces tokens",
      (stack) =>
        Effect.gen(function* () {
          const database = yield* Config.String("PLANETSCALE_SERVICE_TOKEN_DATABASE");
          const { organization } = yield* yield* Planetscale.Credentials;
          const program = (
            accesses: readonly Planetscale.ServiceTokenDatabaseAccess[],
            name = "alchemy-service-token",
          ) => Planetscale.ServiceToken("Token", { database, name, accesses });

          yield* stack.destroy();
          const first = yield* stack.deploy(program(["read_database"]));
          expect(Redacted.value(first.token).length).toBeGreaterThan(0);
          expect(yield* grants(organization, first.id)).toEqual([
            { access: "read_database", resource: { type: "Database", name: database } },
          ]);

          const redeployed = yield* stack.deploy(program(["read_database"]));
          expect(redeployed.id).toBe(first.id);
          expect(Redacted.value(redeployed.token) === Redacted.value(first.token)).toBe(true);

          const updated = yield* stack.deploy(program(["write_database"]));
          expect(updated.id).toBe(first.id);
          expect(Redacted.value(updated.token) === Redacted.value(first.token)).toBe(true);
          expect(yield* grants(organization, first.id)).toEqual([
            { access: "write_database", resource: { type: "Database", name: database } },
          ]);

          yield* ps.addServiceTokenAccess({
            organization,
            id: updated.id,
            database,
            access: ["read_database"],
          });
          yield* stack.deploy(program(["write_database"]));
          expect(yield* grants(organization, first.id)).toEqual([
            { access: "write_database", resource: { type: "Database", name: database } },
          ]);

          yield* ps.deleteServiceToken({ organization, id: updated.id });
          const recovered = yield* stack.deploy(program(["write_database"]));
          expect(recovered.id).not.toBe(updated.id);
          expect(Redacted.value(recovered.token) !== Redacted.value(updated.token)).toBe(true);
          expect(yield* grants(organization, recovered.id)).toEqual([
            { access: "write_database", resource: { type: "Database", name: database } },
          ]);

          const replaced = yield* stack.deploy(
            program(["read_database"], "alchemy-service-token-rotated"),
          );
          expect(replaced.id).not.toBe(recovered.id);
          expect(yield* exists(organization, recovered.id)).toBe(false);
          expect(yield* grants(organization, replaced.id)).toEqual([
            { access: "read_database", resource: { type: "Database", name: database } },
          ]);

          yield* stack.destroy();
          expect(yield* exists(organization, replaced.id)).toBe(false);
        }),
      120_000,
    );
  },
);

const grants = Effect.fn(function* (organization: string, id: string) {
  const response = yield* ps.listServiceTokenAccesses({ organization, id });
  return response.data.map((grant) => ({
    access: grant.access,
    resource: { type: grant.resource.type, name: grant.resource.name },
  }));
});

const exists = (organization: string, id: string) =>
  ps.getServiceToken({ organization, id }).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );
