import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as mybiz from "@distilled.cloud/gcp/mybusinessbusinessinformation_v1";
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

const account = process.env.GCP_MYBUSINESS_ACCOUNT?.trim() || "accounts/-";
const runLifecycle =
  hasGcpCreds && !!process.env.GCP_TEST_MYBUSINESS && !process.env.FAST;

const waitUntilGone = (name: string) =>
  mybiz.getLocations({ name, readMask: "name,title" }).pipe(
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
  "getLocations on a missing location fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        mybiz.getLocations({
          name: "locations/alchemy-missing",
          readMask: "name,title",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || runLifecycle)(
  "createAccountsLocations without Business Profile access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        mybiz.createAccountsLocations({
          parent: account,
          body: {
            title: "Alchemy Probe Shop",
            languageCode: "en",
            storefrontAddress: {
              regionCode: "US",
              postalCode: "94043",
              administrativeArea: "CA",
              locality: "Mountain View",
              addressLines: ["1600 Amphitheatre Parkway"],
            },
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a location",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Mybusinessbusinessinformation.AccountsLocation(
            "Shop",
            {
              parent: account,
              title: "Alchemy Test Shop",
              storefrontAddress: {
                regionCode: "US",
                postalCode: "94043",
                administrativeArea: "CA",
                locality: "Mountain View",
                addressLines: ["1600 Amphitheatre Parkway"],
              },
            },
          );
        }),
      );

      expect(created.name).toContain("locations/");
      expect(created.title).toEqual("Alchemy Test Shop");

      const fetched = yield* mybiz.getLocations({
        name: created.name,
        readMask: "name,title,labels",
      });
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Mybusinessbusinessinformation.AccountsLocation(
            "Shop",
            {
              parent: account,
              title: "Alchemy Test Shop v2",
              storefrontAddress: created.storefrontAddress,
            },
          );
        }),
      );
      expect(updated.name).toEqual(created.name);
      expect(updated.title).toEqual("Alchemy Test Shop v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
