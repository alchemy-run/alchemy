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
const apiProductName = process.env.GCP_TEST_APIGEE_PRODUCT ?? "";

const runLifecycle =
  hasGcpCreds &&
  !!process.env.GCP_TEST_APIGEE &&
  !!siteId &&
  !!apiProductName &&
  !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  apigee.getOrganizationsSitesApidocs({ name }).pipe(
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
  "getOrganizationsSitesApidocs on a missing catalog item fails with NotFound or Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsSitesApidocs({
          name: `organizations/${project}/sites/alchemy-missing-site/apidocs/alchemy-missing-doc`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an Apigee catalog item",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apigee.SitesApidoc("Checkout", {
            siteId,
            apiProductName,
            title: "Checkout API",
            description: "place orders",
          });
        }),
      );

      expect(created.apiDocId).toEqual(expect.any(String));
      expect(created.organization).toEqual(project);
      expect(created.siteId).toEqual(siteId);
      expect(created.apiProductName).toEqual(apiProductName);
      expect(created.title).toEqual("Checkout API");
      expect(created.description).toEqual("place orders");
      expect(created.published).toEqual(false);
      expect(created.name).toEqual(
        `organizations/${project}/sites/${siteId}/apidocs/${created.apiDocId}`,
      );

      const fetched = yield* apigee.getOrganizationsSitesApidocs({
        name: created.name,
      });
      expect(fetched.data?.id).toEqual(created.apiDocId);
      expect(fetched.data?.description).toContain("alchemy-id=");
      expect(fetched.data?.description).toContain("place orders");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apigee.SitesApidoc("Checkout", {
            siteId,
            apiProductName,
            apiDocId: created.apiDocId,
            title: "Checkout API v2",
            description: "place and refund orders",
            published: true,
          });
        }),
      );

      expect(updated.apiDocId).toEqual(created.apiDocId);
      expect(updated.title).toEqual("Checkout API v2");
      expect(updated.description).toEqual("place and refund orders");
      expect(updated.published).toEqual(true);

      const fetchedUpdate = yield* apigee.getOrganizationsSitesApidocs({
        name: updated.name,
      });
      expect(fetchedUpdate.data?.title).toEqual("Checkout API v2");
      expect(fetchedUpdate.data?.description).toContain(
        "place and refund orders",
      );
      expect(fetchedUpdate.data?.description).toContain("alchemy-id=");
      expect(fetchedUpdate.data?.published).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
