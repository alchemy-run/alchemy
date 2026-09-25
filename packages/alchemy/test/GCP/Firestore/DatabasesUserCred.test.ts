import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as firestore from "@distilled.cloud/gcp/firestore_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const runLifecycle = hasGcpCreds && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const enterpriseDatabaseId = "alchfsucreds2";
const enterpriseDatabaseName = `projects/${project}/databases/${enterpriseDatabaseId}`;

const waitUntilGone = (name: string) =>
  firestore.getProjectsDatabasesUserCreds({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const waitUntilDatabase = (name: string, want: "ready" | "gone") =>
  firestore.getProjectsDatabases({ name }).pipe(
    Effect.map((database) =>
      database.deleteTime !== undefined
        ? ("gone" as const)
        : ("ready" as const),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === want,
      times: 10,
    }),
  );

const waitForDatabaseOperation = (
  operation: firestore.GoogleLongrunningOperation,
) =>
  Effect.gen(function* () {
    if (operation.done === true || operation.name === undefined) {
      return operation;
    }
    return yield* firestore
      .getProjectsDatabasesOperations({ name: operation.name })
      .pipe(
        Effect.repeat({
          schedule: Schedule.spaced("4 seconds"),
          until: (current) => current.done === true,
          times: 10,
        }),
      );
  });

const ensureEnterpriseDatabase = Effect.gen(function* () {
  const existing = yield* firestore
    .getProjectsDatabases({
      name: enterpriseDatabaseName,
    })
    .pipe(
      Effect.map((database) =>
        database.deleteTime !== undefined ? undefined : database,
      ),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );
  if (
    existing !== undefined &&
    (existing.databaseEdition ?? "").toUpperCase() === "ENTERPRISE"
  ) {
    return enterpriseDatabaseName;
  }
  if (existing !== undefined) {
    yield* firestore
      .deleteProjectsDatabases({ name: enterpriseDatabaseName })
      .pipe(
        Effect.catchTag(
          ["NotFound", "Forbidden", "BadRequest", "Conflict"],
          () => Effect.void,
        ),
      );
    yield* waitUntilDatabase(enterpriseDatabaseName, "gone");
  }

  const created = yield* firestore
    .createProjectsDatabases({
      parent: `projects/${project}`,
      databaseId: enterpriseDatabaseId,
      body: {
        locationId: "us-central1",
        type: "FIRESTORE_NATIVE",
        databaseEdition: "ENTERPRISE",
        mongodbCompatibleDataAccessMode: "DATA_ACCESS_MODE_ENABLED",
        deleteProtectionState: "DELETE_PROTECTION_DISABLED",
      },
    })
    .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
  if (created !== undefined) {
    yield* waitForDatabaseOperation(created);
  }
  yield* waitUntilDatabase(enterpriseDatabaseName, "ready");
  return enterpriseDatabaseName;
});

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsDatabasesUserCreds on a missing user creds fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        firestore.getProjectsDatabasesUserCreds({
          name: `projects/${project}/databases/alchemy-missing-xxxx/userCreds/alchemy-missing`,
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "createProjectsDatabasesUserCreds on Standard edition fails with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Firestore.Database("App", {
            location: "us-central1",
            type: "FIRESTORE_NATIVE",
          });
        }),
      );

      const error = yield* Effect.flip(
        firestore.createProjectsDatabasesUserCreds({
          parent: created.name,
          userCredsId: "alchemyusercreds",
          body: {},
        }),
      );
      expect(error._tag === "BadRequest" || error._tag === "Forbidden").toBe(
        true,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete firestore user creds on Enterprise",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const ensured = yield* Effect.result(ensureEnterpriseDatabase);
      if (Result.isFailure(ensured)) {
        if (
          ensured.failure._tag === "BadRequest" ||
          ensured.failure._tag === "Forbidden"
        ) {
          return;
        }
        return yield* Effect.fail(ensured.failure);
      }
      const parent = ensured.success;
      yield* firestore
        .deleteProjectsDatabasesUserCreds({
          name: `${parent}/userCreds/appuser`,
        })
        .pipe(Effect.catchTag(["NotFound", "Forbidden"], () => Effect.void));

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Firestore.DatabasesUserCred("AppUser", {
            database: parent,
            userCredsId: "appuser",
          });
        }),
      );

      expect(created.name).toContain("/userCreds/");
      expect(created.databaseId).toEqual(enterpriseDatabaseId);
      expect(created.disabled).toEqual(false);
      expect(created.securePassword).toEqual(expect.any(String));

      const fetched = yield* firestore.getProjectsDatabasesUserCreds({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.state).toEqual("ENABLED");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Firestore.DatabasesUserCred("AppUser", {
            database: parent,
            userCredsId: created.userCredsId,
            disabled: true,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.disabled).toEqual(true);

      const refetched = yield* firestore.getProjectsDatabasesUserCreds({
        name: created.name,
      });
      expect(refetched.state).toEqual("DISABLED");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);
