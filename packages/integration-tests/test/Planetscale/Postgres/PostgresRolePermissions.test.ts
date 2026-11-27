import * as Planetscale from "@alchemy.run/planetscale";
import { fromToken } from "@alchemy.run/planetscale/Credentials";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ps from "@distilled.cloud/planetscale";
import * as Drift from "alchemy/Drift";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Planetscale.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

describe.skipIf(!process.env.PLANETSCALE_TEST)(
  "PostgresRole drift permissions",
  { tags: ["provider:planetscale", "provider:planetscale:postgres", "live"] },
  () => {
    // #2996: a token that can't read a role must fail the drift check, not
    // report the role as missing (which `drift --repair` would recreate).
    test.provider(
      "a role the drift token can't read fails the check instead of reading as missing",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const { database, role, token } = yield* stack.deploy(
            Effect.gen(function* () {
              const database = yield* Planetscale.PostgresDatabase("Database", {
                clusterSize: "PS_10",
              });
              const role = yield* Planetscale.PostgresRole("Role", {
                database,
                inheritedRoles: [],
              });
              // Scoped to the database, without branch or role access.
              const token = yield* Planetscale.ServiceToken("Token", {
                database,
                accesses: ["read_database"],
              });
              return { database, role, token };
            }),
          );

          // The role exists, as seen by the deploying credentials.
          const live = yield* ps.getRole({
            organization: role.organization,
            database: role.database,
            branch: role.branch,
            id: role.id,
          });
          expect(live.id).toBe(role.id);

          const exit = yield* Drift.plan({ name: stack.name, stage: stack.stage }).pipe(
            Effect.provide(stack.state),
            Effect.provide(
              fromToken({
                tokenId: token.id,
                token: token.token,
                organization: token.organization,
              }),
            ),
            Effect.exit,
          );
          // Other resources may also fail to read with this token; the role
          // itself must fail its read with Forbidden.
          expect(Exit.isFailure(exit)).toBe(true);
          const roleFailure = Exit.isFailure(exit)
            ? exit.cause.reasons
                .filter(Cause.isFailReason)
                .map((reason) => reason.error)
                .find(
                  (error): error is Drift.DriftResourceError =>
                    error instanceof Drift.DriftResourceError && error.logicalId === "Role",
                )
            : undefined;
          expect(roleFailure?.operation).toBe("read");
          expect(roleFailure?.cause).toMatchObject({ _tag: "Forbidden" });

          yield* stack.destroy();
          yield* waitForDatabaseToBeDeleted(database.name, database.organization);
        }).pipe(logLevel),
      { timeout: 900_000 },
    );
  },
);

class DatabaseStillExists extends Data.TaggedError("DatabaseStillExists") {}

const waitForDatabaseToBeDeleted = Effect.fn(function* (database: string, organization: string) {
  yield* ps.getDatabase({ organization, database }).pipe(
    Effect.flatMap(() => Effect.fail(new DatabaseStillExists())),
    Effect.retry({
      while: (e): e is DatabaseStillExists => e instanceof DatabaseStillExists,
      schedule: Schedule.spaced("5 seconds"),
      times: 10,
    }),
    Effect.catchTag("NotFound", () => Effect.void),
  );
});
