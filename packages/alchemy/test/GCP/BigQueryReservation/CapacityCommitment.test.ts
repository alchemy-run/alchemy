import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as bigqueryreservation from "@distilled.cloud/gcp/bigqueryreservation_v1";
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

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const runLifecycle =
  hasGcpCreds &&
  !process.env.FAST &&
  process.env.GCP_TEST_BIGQUERY_CAPACITY_COMMITMENT === "1";

const waitUntilGone = (name: string) =>
  bigqueryreservation.getProjectsLocationsCapacityCommitments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsCapacityCommitments on a missing commitment fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        bigqueryreservation.getProjectsLocationsCapacityCommitments({
          name: `projects/${project}/locations/us-central1/capacityCommitments/alchemy-bq-capacity-missing`,
        }),
      );
      expect(error._tag).toBe("NotFound");

      const page =
        yield* bigqueryreservation.listProjectsLocationsCapacityCommitments({
          parent: `projects/${project}/locations/us-central1`,
          pageSize: 10,
        });
      expect(Array.isArray(page.capacityCommitments ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "createProjectsLocationsCapacityCommitments flex plans are end of sale or invalid for editions",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* Effect.result(
        bigqueryreservation.createProjectsLocationsCapacityCommitments({
          parent: `projects/${project}/locations/us-central1`,
          capacityCommitmentId: "alchemy-bq-capacity-probe",
          body: {
            slotCount: "50",
            plan: "FLEX_FLAT_RATE",
            edition: "ENTERPRISE",
          },
        }),
      );
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("BadRequest");
        if (result.failure._tag === "BadRequest") {
          expect(result.failure.message).toMatch(
            /end of sale|Editions commitment|Plan must be/i,
          );
        }
      } else if (result.success.name) {
        yield* bigqueryreservation
          .deleteProjectsLocationsCapacityCommitments({
            name: result.success.name,
            force: true,
          })
          .pipe(
            Effect.retry({
              while: (error) =>
                error._tag === "Conflict" || error._tag === "BadRequest",
              times: 8,
              schedule: Schedule.spaced("8 seconds"),
            }),
            Effect.catchTag("NotFound", () => Effect.void),
          );
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update renewal plan, and delete a flex capacity commitment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.BigQueryReservation.CapacityCommitment("Flex", {
            location: "us-central1",
            slotCount: "50",
            plan: "FLEX_FLAT_RATE",
            edition: "ENTERPRISE",
          });
        }),
      );

      expect(created.name).toContain("/capacityCommitments/");
      expect(created.capacityCommitmentId).toEqual(expect.any(String));
      expect(created.capacityCommitmentId.startsWith("alch-")).toEqual(true);
      expect(created.location).toEqual("us-central1");
      expect(created.slotCount).toEqual("50");
      expect(created.plan).toEqual("FLEX_FLAT_RATE");
      expect(created.edition).toEqual("ENTERPRISE");

      const fetched =
        yield* bigqueryreservation.getProjectsLocationsCapacityCommitments({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.slotCount).toEqual("50");
      expect(fetched.plan).toEqual("FLEX_FLAT_RATE");

      const listed =
        yield* bigqueryreservation.listProjectsLocationsCapacityCommitments({
          parent: `projects/${created.project}/locations/${created.location}`,
        });
      expect(
        (listed.capacityCommitments ?? []).some(
          (item) => item.name === created.name,
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.BigQueryReservation.CapacityCommitment("Flex", {
            capacityCommitmentId: created.capacityCommitmentId,
            location: "us-central1",
            slotCount: "50",
            plan: "FLEX_FLAT_RATE",
            edition: "ENTERPRISE",
            renewalPlan: "FLEX_FLAT_RATE",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.plan).toEqual("FLEX_FLAT_RATE");
      expect(
        updated.renewalPlan === "FLEX_FLAT_RATE" ||
          updated.renewalPlan === undefined,
      ).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
