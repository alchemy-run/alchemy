import * as ml from "@distilled.cloud/gcp/ml_v1";
import * as Layer from "effect/Layer";
import { makeVersionHttpBinding } from "./BindingHttp.ts";
import { GetVersion } from "./GetVersion.ts";

/**
 * HTTP implementation of {@link GetVersion}.
 *
 * @layer
 * @provides GCP.Ml.GetVersion
 */
export const GetVersionHttp = Layer.effect(
  GetVersion,
  makeVersionHttpBinding({
    tag: "GCP.Ml.GetVersion",
    operation: ml.getProjectsModelsVersions,
  }),
);
