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
  hasGcpCreds && !!process.env.GCP_TEST_COMPUTE_LICENSE && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (license: string) =>
  compute.getLicenses({ project, license }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getLicenses on a missing license fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        compute.getLicenses({
          project,
          license: "alchemy-missing-license",
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "probe insertLicenses entitlement",
  () =>
    Effect.gen(function* () {
      const result = yield* compute
        .insertLicenses({
          project,
          body: {
            name: "alchemy-license-probe",
            description: "alchemy entitlement probe",
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
          .deleteLicenses({
            project,
            license: "alchemy-license-probe",
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        return;
      }
      expect(["Forbidden", "BadRequest"]).toContain(result.tag);
    }).pipe(logLevel),
  { timeout: 60_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a license",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.License("ImageLicense", {
            description: "marketplace os",
            transferable: true,
          });
        }),
      );

      expect(created.licenseName).toEqual(expect.any(String));
      expect(created.description).toEqual("marketplace os");
      expect(created.transferable).toEqual(true);
      expect(created.selfLink).toEqual(expect.any(String));

      const fetched = yield* compute.getLicenses({
        project: created.project,
        license: created.licenseName,
      });
      expect(fetched.name).toEqual(created.licenseName);
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("marketplace os");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.License("ImageLicense", {
            licenseName: created.licenseName,
            description: "updated marketplace os",
            transferable: true,
            appendableToDisk: true,
          });
        }),
      );

      expect(updated.licenseName).toEqual(created.licenseName);
      expect(updated.description).toEqual("updated marketplace os");
      expect(updated.appendableToDisk).toEqual(true);

      const refetched = yield* compute.getLicenses({
        project: updated.project,
        license: updated.licenseName,
      });
      expect(refetched.description).toContain("updated marketplace os");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.licenseName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
