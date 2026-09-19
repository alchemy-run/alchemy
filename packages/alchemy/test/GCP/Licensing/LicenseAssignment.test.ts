import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as licensing from "@distilled.cloud/gcp/licensing_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  assertEntitlement,
  customerId,
  hasGcpCreds,
  logLevel,
  missingUserId,
  probeAccess,
  productId,
  skuId,
  updateSkuId,
  userId,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getLicenseAssignments on a missing assignment fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        licensing.getLicenseAssignments({
          productId,
          skuId,
          userId: missingUserId,
        }),
      );
      assertEntitlement(error);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "insertLicenseAssignments without License Manager access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* licensing
        .insertLicenseAssignments({
          productId,
          skuId,
          body: { userId: missingUserId },
        })
        .pipe(
          Effect.map((assignment) => ({
            _tag: "ok" as const,
            assignment,
          })),
          Effect.catchTag(
            ["Forbidden", "NotFound", "BadRequest", "Unauthorized"],
            (error) =>
              Effect.succeed({
                _tag: error._tag,
                assignment: undefined,
              }),
          ),
        );

      if (result._tag === "ok") {
        const assignment = result.assignment;
        yield* licensing
          .deleteLicenseAssignments({
            productId: assignment.productId ?? productId,
            skuId: assignment.skuId ?? skuId,
            userId: assignment.userId ?? missingUserId,
          })
          .pipe(
            Effect.catchTag(
              [
                "NotFound",
                "Forbidden",
                "BadRequest",
                "Conflict",
                "Unauthorized",
              ],
              () => Effect.void,
            ),
          );
      } else {
        assertEntitlement(result);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, update, and delete a license assignment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probeAccess();
      if (access !== "ok") {
        assertEntitlement({ _tag: access });
        yield* stack.destroy();
        return;
      }
      if (!process.env.GOOGLE_LICENSE_USER_ID) {
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Licensing.LicenseAssignment("Seat", {
            productId,
            skuId,
            userId,
            customerId,
          });
        }),
      );

      expect(created.productId).toEqual(productId);
      expect(created.skuId).toEqual(skuId);
      expect(created.userId.toLowerCase()).toEqual(userId.toLowerCase());
      expect(created.project.length).toBeGreaterThan(0);

      const fetched = yield* licensing.getLicenseAssignments({
        productId: created.productId,
        skuId: created.skuId,
        userId: created.userId,
      });
      expect(fetched.productId).toEqual(productId);
      expect(fetched.skuId).toEqual(skuId);
      expect((fetched.userId ?? "").toLowerCase()).toEqual(
        userId.toLowerCase(),
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Licensing.LicenseAssignment("Seat", {
            productId,
            skuId: updateSkuId,
            userId,
            customerId,
          });
        }),
      );

      expect(updated.productId).toEqual(productId);
      expect(updated.userId.toLowerCase()).toEqual(userId.toLowerCase());
      expect(updated.skuId).toEqual(updateSkuId);

      const fetchedUpdate = yield* licensing.getLicenseAssignments({
        productId: updated.productId,
        skuId: updated.skuId,
        userId: updated.userId,
      });
      expect(fetchedUpdate.skuId).toEqual(updateSkuId);

      yield* stack.destroy();

      const gone = yield* waitUntilGone({
        productId: updated.productId,
        skuId: updated.skuId,
        userId: updated.userId,
      });
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
