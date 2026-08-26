import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as reseller from "@distilled.cloud/gcp/reseller_v1";
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

const entitlementTags = ["Forbidden", "NotFound", "BadRequest"] as const;

const probeCustomerId =
  (process.env.GOOGLE_RESELLER_CUSTOMER_ID ?? "C00000000").trim() ||
  "C00000000";
const probeSubscriptionId = "0";
const probeSkuId =
  (process.env.GOOGLE_RESELLER_SKU_ID ?? "Google-Apps").trim() || "Google-Apps";
const lifecycleCustomerId = (
  process.env.GOOGLE_RESELLER_CUSTOMER_ID ?? ""
).trim();
const lifecycleSkuId = (process.env.GOOGLE_RESELLER_SKU_ID ?? "").trim();

const waitUntilGone = (customerId: string, subscriptionId: string) =>
  reseller.getSubscriptions({ customerId, subscriptionId }).pipe(
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

const probeAccess = () =>
  reseller
    .listSubscriptions({
      maxResults: 1,
    })
    .pipe(
      Effect.as("ok" as const),
      Effect.catchTag(["Forbidden", "NotFound"], (error) =>
        Effect.succeed(error),
      ),
    );

test.provider.skipIf(!hasGcpCreds)(
  "getSubscriptions on a missing subscription fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        reseller.getSubscriptions({
          customerId: probeCustomerId,
          subscriptionId: probeSubscriptionId,
        }),
      );
      expect([...entitlementTags]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "insertSubscriptions without Workspace Reseller access fails with a typed entitlement error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        reseller.insertSubscriptions({
          customerId: probeCustomerId,
          body: {
            skuId: probeSkuId,
            plan: { planName: "FLEXIBLE" },
            seats: { maximumNumberOfSeats: 1 },
            purchaseOrderId: "alchemy-reseller-probe",
          },
        }),
      );
      expect([...entitlementTags]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, update, and delete a subscription",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probeAccess();
      if (access !== "ok") {
        expect([...entitlementTags]).toContain(access._tag);
        yield* stack.destroy();
        return;
      }

      if (lifecycleCustomerId.length === 0 || lifecycleSkuId.length === 0) {
        const error = yield* Effect.flip(
          reseller.insertSubscriptions({
            customerId: probeCustomerId,
            body: {
              skuId: probeSkuId,
              plan: { planName: "FLEXIBLE" },
              seats: { maximumNumberOfSeats: 1 },
              purchaseOrderId: "alchemy-reseller-probe",
            },
          }),
        );
        expect([...entitlementTags]).toContain(error._tag);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Reseller.Subscription("Workspace", {
            customerId: lifecycleCustomerId,
            skuId: lifecycleSkuId,
            planName: "FLEXIBLE",
            seats: { maximumNumberOfSeats: 1 },
            purchaseOrderId: "alchemy-ws",
          });
        }),
      );

      expect(created.customerId.length).toBeGreaterThan(0);
      expect(created.subscriptionId.length).toBeGreaterThan(0);
      expect(created.skuId).toEqual(lifecycleSkuId);
      expect(created.purchaseOrderId).toEqual("alchemy-ws");
      expect(created.name).toContain("/subscriptions/");

      const fetched = yield* reseller.getSubscriptions({
        customerId: created.customerId,
        subscriptionId: created.subscriptionId,
      });
      expect(fetched.subscriptionId).toEqual(created.subscriptionId);
      expect(fetched.purchaseOrderId).toContain("[alchemy ");
      expect(fetched.purchaseOrderId).toContain("alchemy-ws");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Reseller.Subscription("Workspace", {
            customerId: created.customerId,
            skuId: created.skuId ?? lifecycleSkuId,
            subscriptionId: created.subscriptionId,
            planName: "FLEXIBLE",
            seats: { maximumNumberOfSeats: 2 },
            purchaseOrderId: "alchemy-ws-2",
          });
        }),
      );

      expect(updated.customerId).toEqual(created.customerId);
      expect(updated.seats?.maximumNumberOfSeats).toEqual(2);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.customerId,
        created.subscriptionId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
