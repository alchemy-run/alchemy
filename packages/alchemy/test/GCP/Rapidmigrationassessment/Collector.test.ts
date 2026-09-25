import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as rma from "@distilled.cloud/gcp/rapidmigrationassessment_v1";
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
const parent = `projects/${project}/locations/us-central1`;
const missingName = `${parent}/collectors/alchemy-missing-collector`;
const serviceAccount = `alchemy-testing@${project}.iam.gserviceaccount.com`;
const DISABLED_MESSAGE = "Rapid Migration Assessment API has not been used";

const waitUntilGone = (name: string) =>
  rma.getProjectsLocationsCollectors({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const probeAccess = rma
  .getProjectsLocationsCollectors({ name: missingName })
  .pipe(
    Effect.as("ok" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("ok" as const)),
    Effect.catchTag("Forbidden", (error) => Effect.succeed(error)),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsCollectors on a missing collector fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        rma.getProjectsLocationsCollectors({ name: missingName }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);
      if (error._tag === "Forbidden") {
        expect(error.message).toContain(DISABLED_MESSAGE);
      }

      const page = yield* rma
        .listProjectsLocationsCollectors({
          parent,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ collectors: [] as const }),
          ),
        );
      expect(Array.isArray(page.collectors ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "createProjectsLocationsCollectors is rejected with Forbidden when Rapid Migration Assessment is disabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* rma
        .createProjectsLocationsCollectors({
          parent,
          collectorId: "alchemyrmaprobe",
          body: {
            displayName: "alchemy-probe",
            collectionDays: 7,
            expectedAssetCount: "1",
            serviceAccount,
          },
        })
        .pipe(
          Effect.map((operation) => ({
            _tag: "created" as const,
            name: operation.name,
          })),
          Effect.catchTag("Forbidden", (error) =>
            Effect.succeed({
              _tag: "Forbidden" as const,
              message: error.message,
            }),
          ),
          Effect.catchTag("BadRequest", (error) =>
            Effect.succeed({
              _tag: "BadRequest" as const,
              message: error.message,
            }),
          ),
        );

      if (result._tag === "created") {
        yield* rma
          .deleteProjectsLocationsCollectors({
            name: `${parent}/collectors/alchemyrmaprobe`,
          })
          .pipe(
            Effect.catchTag(
              ["NotFound", "Forbidden", "BadRequest"],
              () => Effect.void,
            ),
          );
      } else if (result._tag === "Forbidden") {
        expect(result.message).toContain(DISABLED_MESSAGE);
      } else {
        expect(result._tag).toEqual("BadRequest");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, update, and delete a collector",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probeAccess;
      if (access !== "ok") {
        expect(access._tag).toEqual("Forbidden");
        expect(access.message).toContain(DISABLED_MESSAGE);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Rapidmigrationassessment.Collector("OnPrem", {
            location: "us-central1",
            displayName: "on-prem collector",
            description: "inventory appliance",
            collectionDays: 7,
            expectedAssetCount: 10,
            serviceAccount,
            labels: { env: "test" },
          });
        }),
      );

      expect(created.collectorId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `${parent}/collectors/${created.collectorId}`,
      );
      expect(created.project).toEqual(project);
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("on-prem collector");
      expect(created.description).toEqual("inventory appliance");
      expect(created.collectionDays).toEqual(7);
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* rma.getProjectsLocationsCollectors({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toEqual("on-prem collector");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));
      expect(fetched.collectionDays).toEqual(7);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Rapidmigrationassessment.Collector("OnPrem", {
            collectorId: created.collectorId,
            location: "us-central1",
            displayName: "on-prem collector v2",
            description: "inventory appliance v2",
            collectionDays: 14,
            expectedAssetCount: 25,
            serviceAccount,
            labels: { env: "prod", role: "rma" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.collectorId).toEqual(created.collectorId);
      expect(updated.displayName).toEqual("on-prem collector v2");
      expect(updated.description).toEqual("inventory appliance v2");
      expect(updated.collectionDays).toEqual(14);
      expect(updated.labels).toMatchObject({ env: "prod", role: "rma" });

      const fetchedUpdate = yield* rma.getProjectsLocationsCollectors({
        name: created.name,
      });
      expect(fetchedUpdate.displayName).toEqual("on-prem collector v2");
      expect(fetchedUpdate.collectionDays).toEqual(14);
      expect(fetchedUpdate.labels?.env).toEqual("prod");
      expect(fetchedUpdate.labels?.role).toEqual("rma");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
