import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as apihub from "@distilled.cloud/gcp/apihub_v1";
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
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_APIHUB;
const project = process.env.GOOGLE_PROJECT_ID ?? "";
const location = "us-central1";

const waitUntilGone = (name: string) =>
  apihub.getProjectsLocationsAttributes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsAttributes on a missing attribute fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apihub.getProjectsLocationsAttributes({
          name: `projects/${project}/locations/${location}/attributes/alchemy-missing-attr`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an API Hub attribute",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apihub.Attribute("OwnerTeam", {
            location,
            displayName: "owner-team",
            description: "owning team",
            dataType: "STRING",
            scope: "API",
          });
        }),
      );

      expect(created.name).toContain("/attributes/");
      expect(created.attributeId).toEqual(expect.any(String));
      expect(created.displayName).toEqual("owner-team");
      expect(created.description).toEqual("owning team");
      expect(created.dataType).toEqual("STRING");
      expect(created.scope).toEqual("API");

      const fetched = yield* apihub.getProjectsLocationsAttributes({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("owning team");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apihub.Attribute("OwnerTeam", {
            attributeId: created.attributeId,
            location,
            displayName: "owner-team-v2",
            description: "owning team v2",
            dataType: "STRING",
            scope: "API",
            cardinality: 2,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("owner-team-v2");
      expect(updated.description).toEqual("owning team v2");
      expect(updated.cardinality).toEqual(2);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
