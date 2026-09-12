import * as cloudfunctions from "@distilled.cloud/gcp/cloudfunctions_v2";
import * as Layer from "effect/Layer";
import { makeFunctionHttpBinding } from "./BindingHttp.ts";
import { GetFunction } from "./GetFunction.ts";

/**
 * HTTP implementation of {@link GetFunction}.
 *
 * @layer
 * @provides GCP.CloudFunctions.GetFunction
 */
export const GetFunctionHttp = Layer.effect(
  GetFunction,
  makeFunctionHttpBinding({
    tag: "GCP.CloudFunctions.GetFunction",
    operation: cloudfunctions.getProjectsLocationsFunctions,
  }),
);
