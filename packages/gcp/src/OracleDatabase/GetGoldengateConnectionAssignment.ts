import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOracleNameHttpBinding } from "./BindingHttp.ts";
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
 * const get = yield* GCP.OracleDatabase.GetGoldengateConnectionAssignment(a);
 * const live = yield* get();
 * ```
 *
 * @binding
 * @category OracleDatabase
 */
export interface GetGoldengateConnectionAssignment extends Binding.Service<
  GetGoldengateConnectionAssignment,
  "GCP.OracleDatabase.GetGoldengateConnectionAssignment",
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

export const GetGoldengateConnectionAssignment = Binding.Service<GetGoldengateConnectionAssignment>(
  "GCP.OracleDatabase.GetGoldengateConnectionAssignment",
);

/**
 * HTTP implementation of {@link GetGoldengateConnectionAssignment}.
 *
 * @layer
 * @provides GCP.OracleDatabase.GetGoldengateConnectionAssignment
 */
export const GetGoldengateConnectionAssignmentHttp = Layer.effect(
  GetGoldengateConnectionAssignment,
  makeOracleNameHttpBinding({
    tag: "GCP.OracleDatabase.GetGoldengateConnectionAssignment",
    operation: oracle.getProjectsLocationsGoldengateConnectionAssignments,
    iam: { role: "roles/oracledatabase.goldenGateConnectionAssignmentViewer" },
  }),
);
