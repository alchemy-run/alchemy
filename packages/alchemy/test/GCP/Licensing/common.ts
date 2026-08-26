import * as licensing from "@distilled.cloud/gcp/licensing_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

export const entitlementTags = [
  "Forbidden",
  "NotFound",
  "BadRequest",
  "Unauthorized",
] as const;

export const productId = process.env.GOOGLE_LICENSE_PRODUCT_ID ?? "Google-Apps";
export const skuId =
  process.env.GOOGLE_LICENSE_SKU_ID ?? "Google-Apps-For-Business";
export const updateSkuId =
  process.env.GOOGLE_LICENSE_SKU_ID_UPDATE ?? "Google-Apps-Unlimited";
export const userId =
  process.env.GOOGLE_LICENSE_USER_ID ?? "alchemy-missing@example.com";
export const customerId =
  process.env.GOOGLE_LICENSE_CUSTOMER_ID ??
  process.env.GOOGLE_WORKSPACE_CUSTOMER_ID ??
  "my_customer";

export const missingUserId = "alchemy-missing@example.com";

export const probeAccess = () =>
  licensing
    .listForProductLicenseAssignments({
      productId,
      customerId,
      maxResults: 1,
    })
    .pipe(
      Effect.as("ok" as const),
      Effect.catchTag(["Forbidden", "NotFound", "Unauthorized"], (error) =>
        Effect.succeed(error._tag),
      ),
    );

export const waitUntilGone = (
  assignment: Pick<
    licensing.LicenseAssignment,
    "productId" | "skuId" | "userId"
  >,
) =>
  licensing
    .getLicenseAssignments({
      productId: assignment.productId ?? productId,
      skuId: assignment.skuId ?? skuId,
      userId: assignment.userId ?? userId,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag(["NotFound", "Forbidden", "Unauthorized"], () =>
        Effect.succeed("gone" as const),
      ),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

export const assertEntitlement = (error: { _tag: string }) => {
  expect([...entitlementTags]).toContain(error._tag);
};
