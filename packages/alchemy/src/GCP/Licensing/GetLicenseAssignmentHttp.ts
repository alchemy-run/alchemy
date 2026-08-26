import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as licensing from "@distilled.cloud/gcp/licensing_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  GetLicenseAssignment,
  type GetLicenseAssignmentRequest,
} from "./GetLicenseAssignment.ts";
import type { LicenseAssignment } from "./LicenseAssignment.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";

/**
 * HTTP implementation of {@link GetLicenseAssignment}.
 *
 * @layer
 * @provides GCP.Licensing.GetLicenseAssignment
 */
export const GetLicenseAssignmentHttp = Layer.effect(
  GetLicenseAssignment,
  Effect.gen(function* () {
    const get = yield* licensing.getLicenseAssignments;
    return Effect.fn(function* (assignment: LicenseAssignment) {
      yield* bindGcpHost({
        tag: "GCP.Licensing.GetLicenseAssignment",
        resource: assignment,
        iam: [{ role: defaultRoleFor("GCP.Licensing.GetLicenseAssignment") }],
      });
      const productId = yield* assignment.productId;
      const skuId = yield* assignment.skuId;
      const userId = yield* assignment.userId;
      return Effect.fn(
        `GCP.Licensing.GetLicenseAssignment(${assignment.LogicalId})`,
      )(function* (_request: GetLicenseAssignmentRequest) {
        return yield* get({
          productId: yield* productId,
          skuId: yield* skuId,
          userId: yield* userId,
        });
      });
    });
  }),
);
