import * as Planetscale from "@alchemy.run/planetscale";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ps from "@distilled.cloud/planetscale";
import { isActionState, State } from "alchemy/State/State";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Planetscale.providers() });

describe.skipIf(!process.env.PLANETSCALE_TEST)(
  "ServiceToken",
  { tags: ["provider:planetscale", "provider:planetscale:servicetoken", "live"] },
  () => {
    test.provider(
      "MySQL database: retains the secret, converges grants, recovers, and replaces",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          // The token reaches the database through the resource on the first
          // deploy and through `MySQLDatabase.ref` afterwards; both resolve to
          // the same database, so switching between them changes nothing.
          const program = (
            accesses: readonly Planetscale.ServiceTokenDatabaseAccess[],
            options: { name?: string; ref?: boolean } = {},
          ) =>
            Effect.gen(function* () {
              const declared = yield* Planetscale.MySQLDatabase("Database", {
                clusterSize: "PS_10",
              });
              const database = options.ref
                ? yield* Planetscale.MySQLDatabase.ref("Database")
                : declared;
              const token = yield* Planetscale.ServiceToken("Token", {
                name: options.name,
                database,
                accesses,
              });
              return { database: declared, token };
            });

          const { database, token: first } = yield* stack.deploy(program(["read_database"]));
          const { organization } = database;
          expect(first.database).toBe(database.name);
          expect(first.organization).toBe(database.organization);
          expect(Redacted.value(first.token).length).toBeGreaterThan(0);
          expect(yield* grants(organization, first.id)).toEqual([
            { access: "read_database", resource: { type: "Database", name: database.name } },
          ]);

          const { token: viaRef } = yield* stack.deploy(program(["read_database"], { ref: true }));
          expect(viaRef.id).toBe(first.id);
          expect(Redacted.value(viaRef.token)).toBe(Redacted.value(first.token));

          const { token: updated } = yield* stack.deploy(
            program(["write_database"], { ref: true }),
          );
          expect(updated.id).toBe(first.id);
          expect(Redacted.value(updated.token)).toBe(Redacted.value(first.token));
          expect(yield* grants(organization, first.id)).toEqual([
            { access: "write_database", resource: { type: "Database", name: database.name } },
          ]);

          // A grant added outside the stack is revoked on the next deploy.
          yield* ps.addServiceTokenAccess({
            organization,
            id: updated.id,
            database: database.name,
            access: ["read_database"],
          });
          yield* stack.deploy(program(["write_database"], { ref: true }));
          expect(yield* grants(organization, first.id)).toEqual([
            { access: "write_database", resource: { type: "Database", name: database.name } },
          ]);

          // A token deleted outside the stack is minted again.
          yield* ps.deleteServiceToken({ organization, id: updated.id });
          const { token: recreated } = yield* stack.deploy(
            program(["write_database"], { ref: true }),
          );
          expect(recreated.id).not.toBe(updated.id);
          expect(Redacted.value(recreated.token)).not.toBe(Redacted.value(updated.token));
          expect(yield* grants(organization, recreated.id)).toEqual([
            { access: "write_database", resource: { type: "Database", name: database.name } },
          ]);

          // Renaming mints a replacement and revokes the previous token.
          const { token: renamed } = yield* stack.deploy(
            program(["read_database"], { name: "alchemy-service-token-rotated" }),
          );
          expect(renamed.id).not.toBe(recreated.id);
          expect(renamed.name.startsWith("alchemy-service-token-rotated-")).toBe(true);
          expect(yield* exists(organization, recreated.id)).toBe(false);

          // A create whose secret never reached state: deploy revokes the
          // stranded token and mints one whose secret it keeps.
          yield* forgetAttributes(stack);
          const { token: recovered } = yield* stack.deploy(
            program(["read_database"], { name: "alchemy-service-token-rotated" }),
          );
          expect(recovered.id).not.toBe(renamed.id);
          expect(Redacted.value(recovered.token).length).toBeGreaterThan(0);
          expect(yield* exists(organization, renamed.id)).toBe(false);
          expect(yield* grants(organization, recovered.id)).toEqual([
            { access: "read_database", resource: { type: "Database", name: database.name } },
          ]);

          // The same lost create, then destroy: the stranded token is revoked.
          yield* forgetAttributes(stack);
          yield* stack.destroy();
          expect(yield* exists(organization, recovered.id)).toBe(false);
        }),
      { timeout: 900_000 },
    );

    test.provider(
      "Postgres database: grants and updates database accesses",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const program = (accesses: readonly Planetscale.ServiceTokenDatabaseAccess[]) =>
            Effect.gen(function* () {
              const database = yield* Planetscale.PostgresDatabase("Database", {
                clusterSize: "PS_10",
              });
              const token = yield* Planetscale.ServiceToken("Token", { database, accesses });
              return { database, token };
            });

          const { database, token } = yield* stack.deploy(
            program(["read_database", "read_branch", "connect_branch"]),
          );
          expect(token.database).toBe(database.name);
          expect(Redacted.value(token.token).length).toBeGreaterThan(0);
          expect(yield* grants(database.organization, token.id)).toEqual(
            ["connect_branch", "read_branch", "read_database"].map((access) => ({
              access,
              resource: { type: "Database", name: database.name },
            })),
          );

          // PlanetScale stores Vitess-only accesses on a Postgres database
          // too; the token is updated in place to hold exactly the new set.
          const { token: vitess } = yield* stack.deploy(
            program(["read_database", "write_branch_vschema"]),
          );
          expect(vitess.id).toBe(token.id);
          expect(yield* grants(database.organization, token.id)).toEqual(
            ["read_database", "write_branch_vschema"].map((access) => ({
              access,
              resource: { type: "Database", name: database.name },
            })),
          );

          yield* stack.destroy();
          expect(yield* exists(database.organization, token.id)).toBe(false);
        }),
      { timeout: 900_000 },
    );
  },
);

const grants = Effect.fn(function* (organization: string, id: string) {
  const response = yield* ps.listServiceTokenAccesses({ organization, id });
  return response.data
    .map((grant) => ({
      access: grant.access,
      resource: { type: grant.resource.type, name: grant.resource.name },
    }))
    .toSorted((a, b) => a.access.localeCompare(b.access));
});

const exists = (organization: string, id: string) =>
  ps.getServiceToken({ organization, id }).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

/**
 * Reproduce a create whose response or state write was lost: the token exists
 * in PlanetScale, but its row is still `creating`, with no attributes.
 */
const forgetAttributes = (stack: Test.ScratchStack) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const address = { stack: stack.name, stage: stack.stage, fqn: "Token" };
    const stored = yield* state.get(address);
    if (!stored || isActionState(stored) || stored.status !== "created") {
      return yield* Effect.die(new Error("Expected a deployed Token row"));
    }
    const { attr: _, ...rest } = stored;
    yield* state.set({ ...address, value: { ...rest, status: "creating" } });
  }).pipe(Effect.provide(stack.state));
