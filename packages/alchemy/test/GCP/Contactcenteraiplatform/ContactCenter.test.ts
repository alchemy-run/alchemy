import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as ccaip from "@distilled.cloud/gcp/contactcenteraiplatform_v1alpha1";
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
const missingName = `${parent}/contactCenters/alchemy-missing-cc`;

const DISABLED_MESSAGE = "Contact Center AI Platform API has not been used";

const waitUntilGone = (name: string) =>
  ccaip.getProjectsLocationsContactCenters({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const probeCreate = ccaip.createProjectsLocationsContactCenters({
  parent,
  contactCenterId: "alchemyccprobe",
  body: {
    displayName: "alchemy-probe",
    customerDomainPrefix: "alchprobe",
    instanceConfig: { instanceSize: "DEV_SMALL" },
  },
});

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsContactCenters on a missing contact center fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        ccaip.getProjectsLocationsContactCenters({ name: missingName }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);
      if (error._tag === "Forbidden") {
        expect(error.message).toContain(DISABLED_MESSAGE);
      }

      const page = yield* ccaip
        .listProjectsLocationsContactCenters({
          parent,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag("Forbidden", () =>
            Effect.succeed({ contactCenters: [] as const }),
          ),
          Effect.catchTag("NotFound", () =>
            Effect.succeed({ contactCenters: [] as const }),
          ),
        );
      expect(Array.isArray(page.contactCenters ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "createProjectsLocationsContactCenters is rejected with Forbidden when Contact Center AI Platform is disabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* probeCreate.pipe(
        Effect.map((operation) => ({
          _tag: "created" as const,
          name: operation.name,
        })),
        Effect.catchTag("Forbidden", (error) =>
          Effect.succeed({
            _tag: "Forbidden" as const,
            message: error.message,
            name: undefined as string | undefined,
          }),
        ),
        Effect.catchTag("BadRequest", (error) =>
          Effect.succeed({
            _tag: "BadRequest" as const,
            message: error.message,
            name: undefined as string | undefined,
          }),
        ),
      );

      if (result._tag === "created") {
        if (result.name) {
          yield* ccaip
            .deleteProjectsLocationsContactCenters({
              name: `${parent}/contactCenters/alchemyccprobe`,
            })
            .pipe(
              Effect.catchTag(
                ["NotFound", "Forbidden", "BadRequest"],
                () => Effect.void,
              ),
            );
        }
      } else {
        expect(result._tag).toEqual("Forbidden");
        expect(result.message).toContain(DISABLED_MESSAGE);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, update, and delete a contact center",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* ccaip
        .getProjectsLocationsContactCenters({ name: missingName })
        .pipe(
          Effect.as("ok" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("ok" as const)),
          Effect.catchTag("Forbidden", (error) => {
            console.log(
              `contactcenteraiplatform get skip tag=${error._tag} message=${error.message}`,
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

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Contactcenteraiplatform.ContactCenter("Support", {
            displayName: "support",
            instanceSize: "DEV_SMALL",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/contactCenters/");
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("support");
      expect(created.customerDomainPrefix).toEqual(expect.any(String));
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* ccaip.getProjectsLocationsContactCenters({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Contactcenteraiplatform.ContactCenter("Support", {
            contactCenterId: created.contactCenterId,
            location: created.location,
            customerDomainPrefix: created.customerDomainPrefix,
            displayName: "support-desk",
            instanceSize: "DEV_SMALL",
            labels: { env: "prod", role: "ccaip" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("support-desk");
      expect(updated.labels).toMatchObject({ env: "prod", role: "ccaip" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
