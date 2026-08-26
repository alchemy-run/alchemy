import type * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
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
 * const get = yield* GCP.Oracledatabase.GetCloudExadataInfrastructure(infra);
 * const live = yield* get();
 * ```
 *
 * @binding
 * @product GCP
 * @category Oracledatabase
 */
export interface GetCloudExadataInfrastructure extends Binding.Service<
  GetCloudExadataInfrastructure,
  "GCP.Oracledatabase.GetCloudExadataInfrastructure",
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

export const GetCloudExadataInfrastructure =
  Binding.Service<GetCloudExadataInfrastructure>(
    "GCP.Oracledatabase.GetCloudExadataInfrastructure",
  );
