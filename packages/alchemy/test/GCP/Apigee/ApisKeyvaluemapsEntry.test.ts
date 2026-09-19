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
  apigee.getOrganizationsApisKeyvaluemapsEntries({ name }).pipe(
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
  "getOrganizationsApisKeyvaluemapsEntries on a missing entry fails with NotFound or Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsApisKeyvaluemapsEntries({
          name: `${org}/apis/missing-api/keyvaluemaps/missing-map/entries/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an api key value map entry",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* GCP.Apigee.Api("Orders", {});
          const map = yield* GCP.Apigee.ApisKeyvaluemap("Config", {
            api: api.apiId,
          });
          const entry = yield* GCP.Apigee.ApisKeyvaluemapsEntry("Timeout", {
            api: api.apiId,
            map: map.mapId,
            value: "5000",
          });
          return { api, map, entry };
        }),
      );

      expect(created.entry.entryId).toEqual(expect.any(String));
      expect(created.entry.value).toEqual("5000");
      expect(created.entry.mapId).toEqual(created.map.mapId);

      const fetched = yield* apigee.getOrganizationsApisKeyvaluemapsEntries({
        name: created.entry.name,
      });
      expect(fetched.value).toEqual("5000");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* GCP.Apigee.Api("Orders", {
            apiId: created.api.apiId,
          });
          const map = yield* GCP.Apigee.ApisKeyvaluemap("Config", {
            api: api.apiId,
            mapId: created.map.mapId,
          });
          const entry = yield* GCP.Apigee.ApisKeyvaluemapsEntry("Timeout", {
            api: api.apiId,
            map: map.mapId,
            entryId: created.entry.entryId,
            value: "8000",
          });
          return { api, map, entry };
        }),
      );

      expect(updated.entry.name).toEqual(created.entry.name);
      expect(updated.entry.value).toEqual("8000");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.entry.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
