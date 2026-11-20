import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOracleNameHttpBinding } from "./BindingHttp.ts";
import type { CloudExadataInfrastructure } from "./CloudExadataInfrastructure.ts";

export interface GetCloudExadataInfrastructureRequest extends Omit<
  oracle.GetProjectsLocationsCloudExadataInfrastructuresRequest,
  "name"
> {}

/**
 * Runtime binding for Oracle Database `cloudExadataInfrastructures.get`.
 *
 * ### Observing Exadata Infrastructure
 * **Example:** Read the bound infrastructure
 * ```typescript
 * const get = yield* GCP.OracleDatabase.GetCloudExadataInfrastructure(infra);
 * const live = yield* get();
 * ```
 *
 * @binding
 * @category OracleDatabase
 */
export interface GetCloudExadataInfrastructure extends Binding.Service<
  GetCloudExadataInfrastructure,
  "GCP.OracleDatabase.GetCloudExadataInfrastructure",
  (
    infrastructure: CloudExadataInfrastructure,
  ) => Effect.Effect<
    (
      request?: GetCloudExadataInfrastructureRequest,
    ) => Effect.Effect<
      oracle.CloudExadataInfrastructure,
      oracle.GetProjectsLocationsCloudExadataInfrastructuresError,
      RuntimeContext
    >
  >
> {}

export const GetCloudExadataInfrastructure = Binding.Service<GetCloudExadataInfrastructure>(
  "GCP.OracleDatabase.GetCloudExadataInfrastructure",
);

/**
 * HTTP implementation of {@link GetCloudExadataInfrastructure}.
 *
 * @layer
 * @provides GCP.OracleDatabase.GetCloudExadataInfrastructure
 */
export const GetCloudExadataInfrastructureHttp = Layer.effect(
  GetCloudExadataInfrastructure,
  makeOracleNameHttpBinding({
    tag: "GCP.OracleDatabase.GetCloudExadataInfrastructure",
    operation: oracle.getProjectsLocationsCloudExadataInfrastructures,
    iam: { role: "roles/oracledatabase.cloudExadataInfrastructureViewer" },
  }),
);
