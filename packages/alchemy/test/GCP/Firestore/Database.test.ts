import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as firestore from "@distilled.cloud/gcp/firestore_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
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

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  firestore.getProjectsDatabases({ name }).pipe(
    Effect.map((database) =>
      database.deleteTime !== undefined
        ? ("gone" as const)
        : ("found" as const),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsDatabases on a missing database fails with NotFound",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        firestore.getProjectsDatabases({
          name: `projects/${project}/databases/alchemy-missing-xxxx`,
        }),
      );
      expect(error._tag).toBe("NotFound");

      const page = yield* firestore.listProjectsDatabases({
        parent: `projects/${project}`,
      });
      expect(Array.isArray(page.databases ?? [])).toEqual(true);
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, update, and delete a firestore database",
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

      expect(created.name).toContain("/databases/");
      expect(created.databaseId).toEqual(expect.any(String));
      expect(created.databaseId.length).toBeGreaterThanOrEqual(4);
      expect(created.location).toEqual("us-central1");
      expect(created.type).toEqual("FIRESTORE_NATIVE");
      expect(created.deleteProtectionState).toEqual(
        "DELETE_PROTECTION_DISABLED",
      );

      const fetched = yield* firestore.getProjectsDatabases({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.locationId).toEqual("us-central1");
      expect(fetched.type).toEqual("FIRESTORE_NATIVE");

      const ownership = yield* firestore.getProjectsDatabasesDocuments({
        name: `${created.name}/documents/_alchemy/ownership`,
      });
      expect(ownership.fields?.alchemy_stack?.stringValue).toEqual(
        expect.any(String),
      );
      expect(ownership.fields?.alchemy_id?.stringValue).toEqual(
        expect.any(String),
      );

      yield* firestore.patchProjectsDatabasesDocuments({
        name: `${created.name}/documents/users/alice`,
        body: { fields: { name: { stringValue: "Alice" } } },
      });
      const alice = yield* firestore.getProjectsDatabasesDocuments({
        name: `${created.name}/documents/users/alice`,
      });
      expect(alice.fields?.name?.stringValue).toEqual("Alice");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Firestore.Database("App", {
            databaseId: created.databaseId,
            location: "us-central1",
            type: "FIRESTORE_NATIVE",
            concurrencyMode: "OPTIMISTIC",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.concurrencyMode).toEqual("OPTIMISTIC");

      const refetched = yield* firestore.getProjectsDatabases({
        name: created.name,
      });
      expect(refetched.concurrencyMode).toEqual("OPTIMISTIC");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);
