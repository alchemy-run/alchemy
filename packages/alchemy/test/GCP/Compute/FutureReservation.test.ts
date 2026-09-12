import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
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

const runLifecycle =
  hasGcpCreds && !!process.env.GCP_TEST_FUTURE_RESERVATION && !process.env.FAST;

const zone = "us-central1-a";

const draftProps = {
  zone,
  planningStatus: "DRAFT" as const,
  timeWindow: {
    startTime: "2030-06-01T00:00:00Z",
    endTime: "2030-06-08T00:00:00Z",
  },
  specificSkuProperties: {
    totalCount: "1",
    instanceProperties: { machineType: "n2-standard-2" },
  },
};

const waitUntilGone = (
  project: string,
  zoneName: string,
  futureReservation: string,
) =>
  compute
    .getFutureReservations({ project, zone: zoneName, futureReservation })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider.skipIf(!hasGcpCreds)(
  "probe insertFutureReservations entitlement",
  () =>
    Effect.gen(function* () {
      const project = process.env.GOOGLE_PROJECT_ID ?? "";
      const result = yield* compute
        .insertFutureReservations({
          project,
          zone,
          body: {
            name: "alchemy-fr-probe",
            description: "alchemy entitlement probe",
            ...draftProps,
            zone: undefined,
          },
        })
        .pipe(
          Effect.map(() => ({ tag: "ok" as const })),
          Effect.catchTag("Forbidden", (error) =>
            Effect.succeed({
              tag: "Forbidden" as const,
              message: error.message,
            }),
          ),
          Effect.catchTag("BadRequest", (error) =>
            Effect.succeed({
              tag: "BadRequest" as const,
              message: error.message,
            }),
          ),
        );
      if (result.tag === "ok") {
        yield* compute
          .deleteFutureReservations({
            project,
            zone,
            futureReservation: "alchemy-fr-probe",
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        return;
      }
      expect(["Forbidden", "BadRequest"]).toContain(result.tag);
    }).pipe(logLevel),
  { timeout: 60_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a future reservation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.FutureReservation("Burst", {
            ...draftProps,
            description: "draft capacity",
          });
        }),
      );

      expect(created.futureReservationName).toEqual(expect.any(String));
      expect(created.zone).toEqual(zone);
      expect(created.description).toEqual("draft capacity");
      expect(created.planningStatus).toEqual("DRAFT");

      const fetched = yield* compute.getFutureReservations({
        project: created.project,
        zone,
        futureReservation: created.futureReservationName,
      });
      expect(fetched.name).toEqual(created.futureReservationName);
      expect(fetched.description).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.FutureReservation("Burst", {
            ...draftProps,
            futureReservationName: created.futureReservationName,
            description: "updated draft",
          });
        }),
      );
      expect(updated.description).toEqual("updated draft");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        created.project,
        zone,
        created.futureReservationName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
