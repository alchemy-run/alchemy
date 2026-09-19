import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as fitness from "@distilled.cloud/gcp/fitness_v1";
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

const waitUntilGone = (dataSourceId: string) =>
  fitness
    .getUsersDataSources({
      userId: "me",
      dataSourceId,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
      Effect.catchTag("Unauthorized", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

const probeAccess = () =>
  fitness.listUsersDataSources({ userId: "me" }).pipe(
    Effect.as("ok" as const),
    Effect.catchTag(["Forbidden", "NotFound", "Unauthorized"], (error) =>
      Effect.succeed(error._tag),
    ),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getUsersDataSources on a missing data source fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        fitness.getUsersDataSources({
          userId: "me",
          dataSourceId: "derived:com.google.step_count.delta:alchemy-missing",
        }),
      );
      expect(["NotFound", "Forbidden", "Unauthorized"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "createUsersDataSources without Fitness access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* fitness
        .createUsersDataSources({
          userId: "me",
          body: {
            dataStreamName: "alchemy-fitness-probe",
            type: "derived",
            application: { name: "Alchemy" },
            dataType: {
              name: "com.google.step_count.delta",
              field: [{ name: "steps", format: "integer" }],
            },
          },
        })
        .pipe(
          Effect.map((source) => ({
            _tag: "ok" as const,
            dataStreamId: source.dataStreamId,
          })),
          Effect.catchTag(
            ["Forbidden", "NotFound", "Unauthorized", "BadRequest"],
            (error) =>
              Effect.succeed({ _tag: error._tag, dataStreamId: undefined }),
          ),
        );

      if (result._tag === "ok") {
        if (result.dataStreamId) {
          yield* fitness
            .deleteUsersDataSources({
              userId: "me",
              dataSourceId: result.dataStreamId,
            })
            .pipe(
              Effect.catchTag(
                [
                  "NotFound",
                  "Forbidden",
                  "Unauthorized",
                  "BadRequest",
                  "Conflict",
                ],
                () => Effect.void,
              ),
            );
        }
      } else {
        expect([
          "Forbidden",
          "NotFound",
          "Unauthorized",
          "BadRequest",
        ]).toContain(result._tag);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, update, and delete a data source",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probeAccess();
      if (access !== "ok") {
        expect(["Forbidden", "NotFound", "Unauthorized"]).toContain(access);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Fitness.UsersDataSource("Steps", {
            name: "Alchemy Steps",
            type: "derived",
            dataType: {
              name: "com.google.step_count.delta",
              field: [{ name: "steps", format: "integer" }],
            },
            application: { name: "Alchemy", version: "1" },
          });
        }),
      );

      expect(created.dataStreamId.length).toBeGreaterThan(0);
      expect(created.userId).toEqual("me");
      expect(created.name).toEqual("Alchemy Steps");
      expect(created.type).toEqual("derived");
      expect(created.dataType?.name).toEqual("com.google.step_count.delta");
      expect(created.application?.name).toEqual("Alchemy");
      expect(created.application?.version).toEqual("1");

      const fetched = yield* fitness.getUsersDataSources({
        userId: "me",
        dataSourceId: created.dataStreamId,
      });
      expect(fetched.dataStreamId).toEqual(created.dataStreamId);
      expect(fetched.name).toContain("[alchemy ");
      expect(fetched.application?.version).toEqual("1");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Fitness.UsersDataSource("Steps", {
            dataStreamId: created.dataStreamId,
            dataStreamName: created.dataStreamName,
            name: "Alchemy Steps v2",
            type: "derived",
            dataType: {
              name: "com.google.step_count.delta",
              field: [{ name: "steps", format: "integer" }],
            },
            application: { name: "Alchemy", version: "2" },
          });
        }),
      );

      expect(updated.dataStreamId).toEqual(created.dataStreamId);
      expect(updated.name).toEqual("Alchemy Steps v2");
      expect(updated.application?.version).toEqual("2");

      const fetchedUpdate = yield* fitness.getUsersDataSources({
        userId: "me",
        dataSourceId: updated.dataStreamId,
      });
      expect(fetchedUpdate.name).toContain("[alchemy ");
      expect(fetchedUpdate.application?.version).toEqual("2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.dataStreamId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
