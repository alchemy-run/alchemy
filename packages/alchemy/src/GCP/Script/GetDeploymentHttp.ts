import * as script from "@distilled.cloud/gcp/script_v1";
import * as Layer from "effect/Layer";
import { makeDeploymentHttpBinding } from "./BindingHttp.ts";
import { GetDeployment } from "./GetDeployment.ts";

/**
 * HTTP implementation of {@link GetDeployment}.
 *
 * @layer
 * @provides GCP.Script.GetDeployment
 */
export const GetDeploymentHttp = Layer.effect(
  GetDeployment,
  makeDeploymentHttpBinding({
    tag: "GCP.Script.GetDeployment",
    operation: script.getProjectsDeployments,
  }),
);
