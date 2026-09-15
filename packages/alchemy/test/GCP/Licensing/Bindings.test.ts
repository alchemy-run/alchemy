import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  assertEntitlement,
  customerId,
  hasGcpCreds,
  logLevel,
  probeAccess,
  productId,
  skuId,
  userId,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "GetLicenseAssignment round-trip",
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

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const seat = yield* GCP.Licensing.LicenseAssignment("Seat", {
            productId,
            skuId,
            userId,
            customerId,
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* seat.userId;
              const getAssignment =
                yield* GCP.Licensing.GetLicenseAssignment(seat);
              return Effect.fn(function* () {
                return yield* getAssignment({});
              });
            }),
          );
          return { seat, assignment: yield* Probe({}) };
        }),
      );

      expect(out.assignment.productId).toEqual(out.seat.productId);
      expect(out.assignment.skuId).toEqual(out.seat.skuId);
      expect((out.assignment.userId ?? "").toLowerCase()).toEqual(
        out.seat.userId.toLowerCase(),
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
