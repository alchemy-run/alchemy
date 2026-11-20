import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOracleNameHttpBinding } from "./BindingHttp.ts";
import type { GoldengateDeployment } from "./GoldengateDeployment.ts";

export interface GetGoldengateDeploymentRequest extends Omit<
  oracle.GetProjectsLocationsGoldengateDeploymentsRequest,
  "name"
> {}

/**
 * Runtime binding for Oracle Database `goldengateDeployments.get`.
 *
 * ### Observing a GoldenGate Deployment
 * **Example:** Read the bound deployment
 * ```typescript
 * const get = yield* GCP.OracleDatabase.GetGoldengateDeployment(gg);
 * const live = yield* get();
 * ```
 *
 * @binding
 * @category OracleDatabase
 */
export interface GetGoldengateDeployment extends Binding.Service<
  GetGoldengateDeployment,
  "GCP.OracleDatabase.GetGoldengateDeployment",
  (
    deployment: GoldengateDeployment,
  ) => Effect.Effect<
    (
      request?: GetGoldengateDeploymentRequest,
    ) => Effect.Effect<
      oracle.GoldengateDeployment,
      oracle.GetProjectsLocationsGoldengateDeploymentsError,
      RuntimeContext
    >
  >
> {}

export const GetGoldengateDeployment = Binding.Service<GetGoldengateDeployment>(
  "GCP.OracleDatabase.GetGoldengateDeployment",
);

/**
 * HTTP implementation of {@link GetGoldengateDeployment}.
 *
 * @layer
 * @provides GCP.OracleDatabase.GetGoldengateDeployment
 */
export const GetGoldengateDeploymentHttp = Layer.effect(
  GetGoldengateDeployment,
  makeOracleNameHttpBinding({
    tag: "GCP.OracleDatabase.GetGoldengateDeployment",
    operation: oracle.getProjectsLocationsGoldengateDeployments,
    iam: { role: "roles/oracledatabase.goldenGateDeploymentViewer" },
  }),
);
