import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as datastore from "@distilled.cloud/gcp/datastore_v1";
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

const runLifecycle = hasGcpCreds && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (indexId: string) =>
  datastore.getProjectsIndexes({ projectId: project, indexId }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsIndexes on a missing index fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        datastore.getProjectsIndexes({
          projectId: project,
          indexId: "CICAgOjXh4AA",
        }),
      );
      expect(error._tag).toBe("NotFound");

      const page = yield* datastore.listProjectsIndexes({
        projectId: project,
      });
      expect(Array.isArray(page.indexes ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a datastore composite index",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Datastore.Indexe("TasksByDone", {
            ancestor: "NONE",
            properties: [
              { name: "done", direction: "ASCENDING" },
              { name: "priority", direction: "DESCENDING" },
            ],
          });
        }),
      );

      expect(created.indexId).toEqual(expect.any(String));
      expect(created.indexId.length).toBeGreaterThan(0);
      expect(created.kind.length).toBeGreaterThan(0);
      expect(created.ancestor).toEqual("NONE");
      expect(created.name).toContain("/indexes/");

      const fetched = yield* datastore.getProjectsIndexes({
        projectId: project,
        indexId: created.indexId,
      });
      expect(fetched.indexId).toEqual(created.indexId);
      expect(fetched.kind).toEqual(created.kind);
      expect(
        (fetched.properties ?? []).some((property) => property.name === "done"),
      ).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.indexId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);
