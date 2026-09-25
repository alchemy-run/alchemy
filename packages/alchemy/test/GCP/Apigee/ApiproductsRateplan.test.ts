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
  apigee.getOrganizationsApiproductsRateplans({ name }).pipe(
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
  "getOrganizationsApiproductsRateplans on a missing rate plan fails with NotFound or Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsApiproductsRateplans({
          name: `${org}/apiproducts/missing-product/rateplans/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an api product rate plan",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const product = yield* GCP.Apigee.Apiproduct("Public", {
            displayName: "Public APIs",
            approvalType: "auto",
          });
          const plan = yield* GCP.Apigee.ApiproductsRateplan("Standard", {
            apiproduct: product.apiproductId,
            displayName: "Standard",
            description: "monthly plan",
            billingPeriod: "MONTHLY",
            currencyCode: "USD",
            state: "DRAFT",
          });
          return { product, plan };
        }),
      );

      expect(created.plan.rateplanId).toEqual(expect.any(String));
      expect(created.plan.apiproductId).toEqual(created.product.apiproductId);
      expect(created.plan.displayName).toEqual("Standard");
      expect(created.plan.description).toEqual("monthly plan");

      const fetched = yield* apigee.getOrganizationsApiproductsRateplans({
        name: created.plan.name,
      });
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("monthly plan");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const product = yield* GCP.Apigee.Apiproduct("Public", {
            apiproductId: created.product.apiproductId,
            displayName: "Public APIs",
            approvalType: "auto",
          });
          const plan = yield* GCP.Apigee.ApiproductsRateplan("Standard", {
            apiproduct: product.apiproductId,
            displayName: "Standard Plus",
            description: "updated monthly plan",
            billingPeriod: "MONTHLY",
            currencyCode: "USD",
            state: "DRAFT",
          });
          return { product, plan };
        }),
      );

      expect(updated.plan.name).toEqual(created.plan.name);
      expect(updated.plan.displayName).toEqual("Standard Plus");
      expect(updated.plan.description).toEqual("updated monthly plan");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.plan.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
