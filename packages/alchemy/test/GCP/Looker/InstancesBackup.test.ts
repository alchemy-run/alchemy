import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as looker from "@distilled.cloud/gcp/looker_v1";
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

const project = process.env.GOOGLE_PROJECT_ID ?? "alchemy-gcp-testing-83661";
const location = "us-central1";
const instanceParent = `projects/${project}/locations/${location}`;
const missingInstance = `${instanceParent}/instances/alchemy-missing-looker`;
const missingName = `${missingInstance}/backups/alchemy-missing-backup`;

const DISABLED_MESSAGE = "Looker (Google Cloud core) API has not been used";

const waitUntilGone = (name: string) =>
  looker.getProjectsLocationsInstancesBackups({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsInstancesBackups on a missing backup fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        looker.getProjectsLocationsInstancesBackups({ name: missingName }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);
      if (error._tag === "Forbidden") {
        expect(error.message).toContain(DISABLED_MESSAGE);
      }

      const page = yield* looker
        .listProjectsLocationsInstancesBackups({
          parent: missingInstance,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag("Forbidden", () =>
            Effect.succeed({ instanceBackups: [] as const }),
          ),
          Effect.catchTag("NotFound", () =>
            Effect.succeed({ instanceBackups: [] as const }),
          ),
        );
      expect(Array.isArray(page.instanceBackups ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create against a missing Looker instance is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Looker.InstancesBackup("Nightly", {
              instance: missingInstance,
            });
          }),
        ),
      );
      expect([
        "BadRequest",
        "NotFound",
        "Forbidden",
        "GCP.Looker.OperationFailed",
        "GCP.Looker.InstancesBackupFailed",
        "GCP.Looker.InstancesBackupNotReady",
        "GCP.Looker.InstancesBackupNotResolved",
        "GCP.Looker.InstancesBackupInstanceMissing",
      ]).toContain(error._tag);
      if (error._tag === "Forbidden") {
        expect(error.message).toContain(DISABLED_MESSAGE);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, refresh, and delete a Looker instance backup",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* looker
        .getProjectsLocationsInstancesBackups({ name: missingName })
        .pipe(
          Effect.as("ok" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("ok" as const)),
          Effect.catchTag("Forbidden", (error) => {
            console.log(
              `looker get skip tag=${error._tag} message=${error.message}`,
            );
            return Effect.succeed(error);
          }),
        );
      if (access !== "ok") {
        expect(access._tag).toEqual("Forbidden");
        expect(access.message).toContain(DISABLED_MESSAGE);
        yield* stack.destroy();
        return;
      }

      const instances = yield* looker
        .listProjectsLocationsInstances({
          parent: instanceParent,
          pageSize: 50,
        })
        .pipe(
          Effect.map((page) =>
            (page.instances ?? []).filter(
              (instance) =>
                (instance.name ?? "").length > 0 &&
                (instance.state ?? "").toUpperCase() === "ACTIVE",
            ),
          ),
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed([] as looker.Instance[]),
          ),
        );

      const parent = instances[0]?.name;
      if (parent === undefined) {
        const probe = yield* looker
          .createProjectsLocationsInstancesBackups({
            parent: missingInstance,
            body: {},
          })
          .pipe(
            Effect.map((operation) => ({
              _tag: "created" as const,
              name: operation.name,
            })),
            Effect.catchTag(["NotFound", "Forbidden", "BadRequest"], (error) =>
              Effect.succeed({
                _tag: error._tag,
                name: undefined as string | undefined,
                message: error.message,
              }),
            ),
          );
        expect(["NotFound", "Forbidden", "BadRequest"]).toContain(probe._tag);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Looker.InstancesBackup("Nightly", {
            instance: parent,
          });
        }),
      );

      expect(created.name).toContain("/backups/");
      expect(created.instance).toEqual(parent);
      expect(created.location).toEqual(location);
      expect(created.backupId).toEqual(expect.any(String));
      expect(created.state).toEqual("ACTIVE");

      const fetched = yield* looker.getProjectsLocationsInstancesBackups({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.state).toEqual("ACTIVE");

      const refreshed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Looker.InstancesBackup("Nightly", {
            instance: parent,
            backupId: created.backupId,
          });
        }),
      );

      expect(refreshed.name).toEqual(created.name);
      expect(refreshed.backupId).toEqual(created.backupId);
      expect(refreshed.state).toEqual("ACTIVE");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
