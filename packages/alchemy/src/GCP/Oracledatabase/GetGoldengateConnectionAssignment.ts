import type * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { GoldengateConnectionAssignment } from "./GoldengateConnectionAssignment.ts";

export interface GetGoldengateConnectionAssignmentRequest extends Omit<
  oracle.GetProjectsLocationsGoldengateConnectionAssignmentsRequest,
  "name"
> {}

/**
 * Runtime binding for Oracle Database `goldengateConnectionAssignments.get`.
 *
 * ### Observing assignments
 * **Example:** Read the bound assignment
 * ```typescript
 * const get = yield* GCP.Oracledatabase.GetGoldengateConnectionAssignment(a);
 * const live = yield* get();
 * ```
 *
 * @binding
 * @product GCP
 * @category Oracledatabase
 */
export interface GetGoldengateConnectionAssignment extends Binding.Service<
  GetGoldengateConnectionAssignment,
  "GCP.Oracledatabase.GetGoldengateConnectionAssignment",
  (
    assignment: GoldengateConnectionAssignment,
  ) => Effect.Effect<
    (
      request?: GetGoldengateConnectionAssignmentRequest,
    ) => Effect.Effect<
      oracle.GoldengateConnectionAssignment,
      oracle.GetProjectsLocationsGoldengateConnectionAssignmentsError,
      RuntimeContext
    >
  >
> {}

export const GetGoldengateConnectionAssignment =
  Binding.Service<GetGoldengateConnectionAssignment>(
    "GCP.Oracledatabase.GetGoldengateConnectionAssignment",
  );
