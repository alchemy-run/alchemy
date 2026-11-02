import * as serviceAccount from "@distilled.cloud/stackit/service_account";
import * as Layer from "effect/Layer";
import { makePublicServiceAccountHttpBinding } from "./BindingHttp.ts";
import { GetJWKS } from "./GetJWKS.ts";

/**
 * HTTP implementation of {@link GetJWKS}.
 *
 * @layer
 * @provides Stackit.IAM.GetJWKS
 */
export const GetJWKSHttp = Layer.effect(
  GetJWKS,
  makePublicServiceAccountHttpBinding({
    tag: "Stackit.IAM.GetJWKS",
    operation: serviceAccount.getJWKS,
  }),
);
