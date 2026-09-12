import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
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

const organizationId = process.env.GOOGLE_ORGANIZATION_ID ?? "";
const runLifecycle =
  hasGcpCreds && !process.env.FAST && organizationId.length > 0;

const waitUntilGone = (name: string) =>
  dataplex.getOrganizationsLocationsEncryptionConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getOrganizationsLocationsEncryptionConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const org = organizationId.length > 0 ? organizationId : "000000000000";
      const error = yield* Effect.flip(
        dataplex.getOrganizationsLocationsEncryptionConfigs({
          name: `organizations/${org}/locations/us-central1/encryptionConfigs/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an encryption config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataplex.EncryptionConfig("Default", {
            organizationId,
            location: "us-central1",
            encryptionConfigId: "default",
            enableMetastoreEncryption: false,
          });
        }),
      );

      expect(created.name).toContain("/encryptionConfigs/");
      expect(created.encryptionConfigId).toEqual("default");
      expect(created.organizationId).toEqual(organizationId);
      expect(created.location).toEqual("us-central1");

      const fetched =
        yield* dataplex.getOrganizationsLocationsEncryptionConfigs({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataplex.EncryptionConfig("Default", {
            organizationId,
            location: "us-central1",
            encryptionConfigId: "default",
            enableMetastoreEncryption: false,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
