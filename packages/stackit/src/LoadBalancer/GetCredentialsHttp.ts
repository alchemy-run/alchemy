import * as lb from "@distilled.cloud/stackit/load_balancer";
import * as Layer from "effect/Layer";
import { makeCredentialHttpBinding } from "./BindingHttp.ts";
import { GetCredentials } from "./GetCredentials.ts";

/**
 * HTTP implementation of {@link GetCredentials}.
 *
 * @layer
 * @provides Stackit.LoadBalancer.GetCredentials
 */
export const GetCredentialsHttp = Layer.effect(
  GetCredentials,
  makeCredentialHttpBinding({
    tag: "Stackit.LoadBalancer.GetCredentials",
    access: { permissions: ["nlb.credentials.get"] },
    operation: lb.getCredentials,
  }),
);
