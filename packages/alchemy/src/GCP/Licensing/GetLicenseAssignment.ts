import type * as licensing from "@distilled.cloud/gcp/licensing_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { LicenseAssignment } from "./LicenseAssignment.ts";

export interface GetLicenseAssignmentRequest extends Omit<
  licensing.GetLicenseAssignmentsRequest,
  "productId" | "skuId" | "userId"
> {}

/**
 * Runtime binding for Enterprise License Manager
 * `licenseAssignments.get`.
 *
 * Bind this operation to a {@link LicenseAssignment} in a
 * Function/Action init phase. Provide {@link GetLicenseAssignmentHttp}.
 *
 * ### Reading Assignments
 * **Example:** Read a user's license
 * ```typescript
 * const getAssignment = yield* GCP.Licensing.GetLicenseAssignment(seat);
 * const assignment = yield* getAssignment({});
 * ```
 *
 * @binding
 * @product GCP
 * @category Licensing
 */
export interface GetLicenseAssignment extends Binding.Service<
  GetLicenseAssignment,
  "GCP.Licensing.GetLicenseAssignment",
  (
    assignment: LicenseAssignment,
  ) => Effect.Effect<
    (
      request: GetLicenseAssignmentRequest,
    ) => Effect.Effect<
      licensing.LicenseAssignment,
      licensing.GetLicenseAssignmentsError,
      RuntimeContext
    >
  >
> {}

export const GetLicenseAssignment = Binding.Service<GetLicenseAssignment>(
  "GCP.Licensing.GetLicenseAssignment",
);
