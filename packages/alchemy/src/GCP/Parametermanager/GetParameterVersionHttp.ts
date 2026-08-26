import * as parametermanager from "@distilled.cloud/gcp/parametermanager_v1";
import * as Layer from "effect/Layer";
import { makeParameterVersionHttpBinding } from "./BindingHttp.ts";
import {
  GetParameterVersion,
  type GetParameterVersionRequest,
} from "./GetParameterVersion.ts";

/**
 * HTTP implementation of {@link GetParameterVersion}.
 *
 * @layer
 * @provides GCP.Parametermanager.GetParameterVersion
 */
export const GetParameterVersionHttp = Layer.effect(
  GetParameterVersion,
  makeParameterVersionHttpBinding<
    parametermanager.GetProjectsLocationsParametersVersionsRequest,
    parametermanager.ParameterVersion,
    parametermanager.GetProjectsLocationsParametersVersionsError,
    GetParameterVersionRequest
  >({
    tag: "GCP.Parametermanager.GetParameterVersion",
    operation: parametermanager.getProjectsLocationsParametersVersions,
    toInput: (name, request) => ({
      name,
      view: request?.view ?? "FULL",
    }),
  }),
);
