import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as iap from "@distilled.cloud/gcp/iap_v1";
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

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const runOauthLifecycle =
  hasGcpCreds && !process.env.FAST && process.env.GCP_TEST_IAP_OAUTH === "1";

const waitUntilGone = (name: string) =>
  iap.getProjectsBrandsIdentityAwareProxyClients({ name }).pipe(
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
  "getProjectsBrandsIdentityAwareProxyClients on a missing client fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        iap.getProjectsBrandsIdentityAwareProxyClients({
          name: `projects/${project}/brands/missing/identityAwareProxyClients/missing`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || process.env.GCP_TEST_IAP_OAUTH === "1")(
  "createProjectsBrands without a Workspace support email fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        iap.createProjectsBrands({
          parent: `projects/${project}`,
          body: {
            applicationTitle: "Alchemy IAP probe",
            supportEmail: "iap@example.com",
          },
        }),
      );
      expect(error._tag).toEqual("BadRequest");
      expect(error.message).toContain("invalid argument");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || process.env.GCP_TEST_IAP_OAUTH === "1")(
  "createProjectsBrandsIdentityAwareProxyClients without a Workspace brand fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        iap.createProjectsBrandsIdentityAwareProxyClients({
          parent: `projects/${project}/brands/missing`,
          body: { displayName: "Alchemy IAP client probe" },
        }),
      );
      expect(error._tag).toEqual("BadRequest");
      expect(error.message).toContain(
        "Unable to parse project number and brand",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runOauthLifecycle)(
  "create, replace, and delete an IAP OAuth client",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const brands = yield* iap
        .listProjectsBrands({ parent: `projects/${project}` })
        .pipe(
          Effect.map((page) => page.brands ?? []),
          Effect.catchTag("Forbidden", (error) => Effect.succeed(error)),
          Effect.catchTag("NotFound", (error) => Effect.succeed(error)),
        );
      if (!Array.isArray(brands)) {
        expect(["Forbidden", "NotFound"]).toContain(brands._tag);
        yield* stack.destroy();
        return;
      }
      const brand = brands[0]?.name;
      if (brand === undefined) {
        const createdBrand = yield* iap
          .createProjectsBrands({
            parent: `projects/${project}`,
            body: {
              applicationTitle: "Alchemy IAP",
              supportEmail: "iap@example.com",
            },
          })
          .pipe(
            Effect.catchTag("Forbidden", (error) => Effect.succeed(error)),
            Effect.catchTag("BadRequest", (error) => Effect.succeed(error)),
            Effect.catchTag("Conflict", (error) => Effect.succeed(error)),
            Effect.catchTag("NotFound", (error) => Effect.succeed(error)),
          );
        if (!("name" in createdBrand) || createdBrand.name === undefined) {
          expect(["Forbidden", "BadRequest", "Conflict", "NotFound"]).toContain(
            (createdBrand as { _tag: string })._tag,
          );
          yield* stack.destroy();
          return;
        }
      }
      const brandName =
        brand ??
        (yield* iap.listProjectsBrands({
          parent: `projects/${project}`,
        })).brands?.[0]?.name;
      if (brandName === undefined) {
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Iap.BrandsIdentityAwareProxyClient("Console", {
            brand: brandName,
            displayName: "Alchemy console",
          });
        }),
      );

      expect(created.name).toContain("/identityAwareProxyClients/");
      expect(created.brand).toEqual(brandName);
      expect(created.displayName).toEqual("Alchemy console");
      expect(created.identityAwareProxyClientId.length).toBeGreaterThan(0);

      const fetched = yield* iap.getProjectsBrandsIdentityAwareProxyClients({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("[alchemy ");
      expect(fetched.displayName).toContain("Alchemy console");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Iap.BrandsIdentityAwareProxyClient("Console", {
            brand: brandName,
            displayName: "Alchemy portal",
          });
        }),
      );

      expect(replaced.displayName).toEqual("Alchemy portal");
      expect(replaced.brand).toEqual(brandName);

      const fetchedReplace =
        yield* iap.getProjectsBrandsIdentityAwareProxyClients({
          name: replaced.name,
        });
      expect(fetchedReplace.displayName).toContain("Alchemy portal");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
