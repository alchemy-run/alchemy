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

const siteId = process.env.GCP_TEST_APIGEE_SITE ?? "";

const runLifecycle =
  hasGcpCreds && !!process.env.GCP_TEST_APIGEE && !!siteId && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  apigee.getOrganizationsSitesApicategories({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getOrganizationsSitesApicategories on a missing category fails with NotFound or Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsSitesApicategories({
          name: `organizations/${project}/sites/alchemy-missing-site/apicategories/alchemy-missing-category`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an Apigee API category",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apigee.SitesApicategory("Payments", {
            siteId,
            name: "Payments",
          });
        }),
      );

      expect(created.categoryId).toEqual(expect.any(String));
      expect(created.organization).toEqual(project);
      expect(created.siteId).toEqual(siteId);
      expect(created.categoryName).toEqual("Payments");
      expect(created.name).toEqual(
        `organizations/${project}/sites/${siteId}/apicategories/${created.categoryId}`,
      );

      const fetched = yield* apigee.getOrganizationsSitesApicategories({
        name: created.name,
      });
      expect(fetched.data?.id).toEqual(created.categoryId);
      expect(fetched.data?.name).toContain("alchemy-id=");
      expect(fetched.data?.name).toContain("Payments");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apigee.SitesApicategory("Payments", {
            siteId,
            categoryId: created.categoryId,
            name: "Billing",
          });
        }),
      );

      expect(updated.categoryId).toEqual(created.categoryId);
      expect(updated.categoryName).toEqual("Billing");

      const fetchedUpdate = yield* apigee.getOrganizationsSitesApicategories({
        name: updated.name,
      });
      expect(fetchedUpdate.data?.name).toContain("Billing");
      expect(fetchedUpdate.data?.name).toContain("alchemy-id=");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
