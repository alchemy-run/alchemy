import * as Planetscale from "@alchemy.run/planetscale";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as ps from "@distilled.cloud/planetscale";
import * as Output from "alchemy/Output";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

const { test } = Test.make({ providers: Planetscale.providers() });

// The target belongs to another stack, as a lookup's target always should.
const target = () =>
  Core.scratchStack({ providers: Planetscale.providers() }, "PlanetscaleLookupTarget");

describe
  .skipIf(!process.env.PLANETSCALE_TEST)
  .concurrent(
    "lookup",
    { tags: ["provider:planetscale", "provider:planetscale:postgres", "live"] },
    () => {
      test.provider(
        "a looked-up database holds a declared branch and survives its destroy",
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const owner = target();
            yield* owner.destroy();
            const database = yield* owner.deploy(
              Planetscale.PostgresDatabase("LookupTarget", { clusterSize: "PS_10" }),
            );

            const program = Planetscale.PostgresBranch("OnLookedUpDatabase", {
              database: Planetscale.PostgresDatabase.lookup({ name: database.name }),
              parentBranch: "main",
            });
            const branch = yield* stack.deploy(program);
            expect(branch.database).toEqual(database.name);
            const stored = yield* ps.getBranch({
              organization: database.organization,
              database: database.name,
              branch: branch.name,
            });
            expect(stored.name).toEqual(branch.name);

            // A lookup re-resolves to the same database.
            const plan = yield* stack.plan(program);
            expect(plan.resources.OnLookedUpDatabase?.action).toEqual("noop");

            // Destroying the consumer removes the branch, never the database.
            yield* stack.destroy();
            const after = yield* ps.getDatabase({
              organization: database.organization,
              database: database.name,
            });
            expect(after.name).toEqual(database.name);

            yield* owner.destroy();
          }),
        { timeout: 900_000 },
      );

      test.provider("a lookup of a resource that doesn't exist fails the plan", (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const lookups = {
            MySQLDatabase: Planetscale.MySQLDatabase.lookup({ name: "alchemy-missing-db" }),
            PostgresDatabase: Planetscale.PostgresDatabase.lookup({ name: "alchemy-missing-db" }),
            MySQLBranch: Planetscale.MySQLBranch.lookup({
              database: "alchemy-missing-db",
              name: "main",
            }),
            PostgresBranch: Planetscale.PostgresBranch.lookup({
              database: "alchemy-missing-db",
              name: "main",
            }),
          } as unknown as Record<string, Output.Output<unknown>>;

          const mismatches: Record<string, string> = {};
          for (const [id, lookup] of Object.entries(lookups)) {
            const exit = yield* Effect.exit(
              stack.plan(
                Planetscale.MySQLDatabase(id, {
                  clusterSize: "PS_10",
                  migrationTableName: Output.interpolate`${lookup}`,
                }),
              ),
            );
            const pretty = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "plan succeeded";
            if (!pretty.includes("LookupNotFoundError")) {
              mismatches[id] = pretty.split("\n")[0]!.slice(0, 300);
            }
          }
          expect(mismatches).toEqual({});
        }),
      );
    },
  );
