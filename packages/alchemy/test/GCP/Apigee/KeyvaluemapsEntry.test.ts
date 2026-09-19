import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as apigee from "@distilled.cloud/gcp/apigee_v1";
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
  hasGcpCreds && !!process.env.GCP_TEST_APIGEE && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const org = `organizations/${project}`;

const waitUntilGone = (name: string) =>
  apigee.getOrganizationsKeyvaluemapsEntries({ name }).pipe(
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
  "getOrganizationsKeyvaluemapsEntries on a missing entry fails with NotFound or Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsKeyvaluemapsEntries({
          name: `${org}/keyvaluemaps/alchemy-missing/entries/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an organization key value map entry",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const map = yield* GCP.Apigee.Keyvaluemap("Config", {});
          const entry = yield* GCP.Apigee.KeyvaluemapsEntry("ApiKey", {
            map: map.mapId,
            value: "secret-value",
          });
          return { map, entry };
        }),
      );

      expect(created.entry.entryId).toEqual(expect.any(String));
      expect(created.entry.mapId).toEqual(created.map.mapId);
      expect(created.entry.value).toEqual("secret-value");

      const fetched = yield* apigee.getOrganizationsKeyvaluemapsEntries({
        name: created.entry.name,
      });
      expect(fetched.value).toContain("alchemy-id=");
      expect(fetched.value).toContain("secret-value");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const map = yield* GCP.Apigee.Keyvaluemap("Config", {
            mapId: created.map.mapId,
          });
          const entry = yield* GCP.Apigee.KeyvaluemapsEntry("ApiKey", {
            map: map.mapId,
            entryId: created.entry.entryId,
            value: "rotated-value",
          });
          return { map, entry };
        }),
      );

      expect(updated.entry.name).toEqual(created.entry.name);
      expect(updated.entry.value).toEqual("rotated-value");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.entry.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
