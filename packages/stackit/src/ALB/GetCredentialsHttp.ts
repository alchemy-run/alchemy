import * as alb from "@distilled.cloud/stackit/alb";
import * as Layer from "effect/Layer";
import { makeCredentialHttpBinding } from "./BindingHttp.ts";
import { GetCredentials } from "./GetCredentials.ts";

/**
 * HTTP implementation of {@link GetCredentials}.
 *
 * @layer
 * @provides Stackit.ALB.GetCredentials
 */
export const GetCredentialsHttp = Layer.effect(
  GetCredentials,
  makeCredentialHttpBinding({
    tag: "Stackit.ALB.GetCredentials",
    access: { permissions: ["alb.credentials.get"] },
    operation: alb.getCredentials,
  }),
);
