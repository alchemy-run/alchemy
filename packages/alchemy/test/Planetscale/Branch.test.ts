import * as Planetscale from "@/Planetscale";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as ops from "@distilled.cloud/planetscale/Operations";
import { describe, expect } from "@effect/vitest";
import { Data, Schedule } from "effect";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Planetscale.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

describe.skipIf(!process.env.PLANETSCALE_TEST)("Branch", () => {
  // Canonical `list()` test (PARENT FAN-OUT): branches live under a database
  // within the credentialed organization. `list()` enumerates every database
  // in the org, lists each database's branches, and keeps only the engine's
  // kind (here MySQL). Deploy one branch, then assert it appears in the
  // exhaustively-paginated result.
  test.provider(
    "list enumerates the deployed branch across the org",
    (stack) =>
      Effect.gen(function* () {
        const dbName = "alchemy-branch-list";
        const branchName = "list-target";

        yield* stack.destroy();

        const { database, branch } = yield* stack.deploy(
          Effect.gen(function* () {
            const database = yield* Planetscale.MySQLDatabase("Database", {
              name: dbName,
              region: { slug: "us-east" },
              clusterSize: "PS_10",
            });
            const branch = yield* Planetscale.MySQLBranch("ListBranch", {
              name: branchName,
              database,
              parentBranch: "main",
              isProduction: false,
            });

            return { database, branch };
          }),
        );

        const provider = yield* Provider.findProvider(Planetscale.MySQLBranch);
        const all = yield* provider.list();

        const found = all.find(
          (b) =>
            b.organization === database.organization &&
            b.database === dbName &&
            b.name === branch.name,
        );

        expect(found).toBeDefined();
        expect(found).toMatchObject({
          organization: database.organization,
          database: dbName,
          name: branch.name,
          parentBranch: "main",
          production: false,
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          htmlUrl: expect.any(String),
          region: { slug: expect.any(String) },
        });

        // Every item is hydrated into the exact `read` Attributes shape — the
        // org's `main` branch is enumerated too, only as MySQL kind.
        expect(all.every((b) => b.organization === database.organization)).toBe(
          true,
        );

        yield* stack.destroy();
        yield* waitForDatabaseToBeDeleted(dbName, database.organization);
      }).pipe(logLevel),
    5_000_000,
  );
});

const waitForDatabaseToBeDeleted = Effect.fn(function* (
  database: string,
  organization: string,
) {
  yield* ops
    .getDatabase({
      organization,
      database,
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new DatabaseStillExists())),
      Effect.retry({
        while: (e): e is DatabaseStillExists =>
          e instanceof DatabaseStillExists,
        schedule: Schedule.exponential(100),
      }),
      Effect.catchTag("NotFound", () => Effect.void),
    );
});

class DatabaseStillExists extends Data.TaggedError("DatabaseStillExists") {}
