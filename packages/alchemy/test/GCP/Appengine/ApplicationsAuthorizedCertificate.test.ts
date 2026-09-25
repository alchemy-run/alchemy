import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as appengine from "@distilled.cloud/gcp/appengine_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { CERT_A, CERT_B, KEY_A, KEY_B } from "./fixtures/cert.ts";

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
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_APPENGINE;

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const location = "us-central";

const waitUntilGone = (
  projectsId: string,
  locationsId: string,
  applicationsId: string,
  certificateId: string,
) =>
  appengine
    .getProjectsLocationsApplicationsAuthorizedCertificates({
      projectsId,
      locationsId,
      applicationsId,
      authorizedCertificatesId: certificateId,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsApplicationsAuthorizedCertificates on a missing certificate fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        appengine.getProjectsLocationsApplicationsAuthorizedCertificates({
          projectsId: project,
          locationsId: location,
          applicationsId: project,
          authorizedCertificatesId: "missing",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_APPENGINE)(
  "createProjectsLocationsApplicationsAuthorizedCertificates without an App Engine app fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        appengine.createProjectsLocationsApplicationsAuthorizedCertificates({
          projectsId: project,
          locationsId: location,
          applicationsId: project,
          body: {
            displayName: "Alchemy Appengine Probe",
            certificateRawData: {
              publicCertificate: CERT_A,
              privateKey: KEY_A,
            },
          },
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an applications authorized certificate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Appengine.ApplicationsAuthorizedCertificate(
            "FrontendTls",
            {
              displayName: "frontend",
              publicCertificate: CERT_A,
              privateKey: KEY_A,
            },
          );
        }),
      );

      expect(created.certificateId.length).toBeGreaterThan(0);
      expect(created.displayName).toEqual("frontend");
      expect(created.applicationsId).toEqual(project);

      const fetched =
        yield* appengine.getProjectsLocationsApplicationsAuthorizedCertificates(
          {
            projectsId: created.project,
            locationsId: created.location,
            applicationsId: created.applicationsId,
            authorizedCertificatesId: created.certificateId,
          },
        );
      expect(fetched.id).toEqual(created.certificateId);
      expect(fetched.displayName).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Appengine.ApplicationsAuthorizedCertificate(
            "FrontendTls",
            {
              certificateId: created.certificateId,
              location: created.location,
              displayName: "frontend-prod",
              publicCertificate: CERT_B,
              privateKey: KEY_B,
            },
          );
        }),
      );

      expect(updated.certificateId).toEqual(created.certificateId);
      expect(updated.displayName).toEqual("frontend-prod");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.project,
        created.location,
        created.applicationsId,
        created.certificateId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
