import type * as parametermanager from "@distilled.cloud/gcp/parametermanager_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { ParametersVersion } from "./ParametersVersion.ts";

export interface GetParameterVersionRequest {
  /**
   * View of the ParameterVersion. `FULL` (the default) includes payload.
   * `BASIC` returns metadata only.
   * @default "FULL"
   */
  view?:
    | parametermanager.GetProjectsLocationsParametersVersionsViewEnum
    | (string & {});
}

/**
 * Runtime binding for Parameter Manager `parameters.versions.get`.
 *
 * Bind this operation to a {@link ParametersVersion} in a Function/Action
 * init phase. Provide {@link GetParameterVersionHttp}.
 *
 * ### Reading a Parameter Version
 * **Example:** Get payload
 * ```typescript
 * const getVersion = yield* GCP.Parametermanager.GetParameterVersion(version);
 * const live = yield* getVersion();
 * ```
 *
 * **Example:** Metadata only
 * ```typescript
 * const getVersion = yield* GCP.Parametermanager.GetParameterVersion(version);
 * const live = yield* getVersion({ view: "BASIC" });
 * ```
 *
 * @binding
 * @product GCP
 * @category Parametermanager
 */
export interface GetParameterVersion extends Binding.Service<
  GetParameterVersion,
  "GCP.Parametermanager.GetParameterVersion",
  (
    version: ParametersVersion,
  ) => Effect.Effect<
    (
      request?: GetParameterVersionRequest,
    ) => Effect.Effect<
      parametermanager.ParameterVersion,
      parametermanager.GetProjectsLocationsParametersVersionsError,
      RuntimeContext
    >
  >
> {}

export const GetParameterVersion = Binding.Service<GetParameterVersion>(
  "GCP.Parametermanager.GetParameterVersion",
);
