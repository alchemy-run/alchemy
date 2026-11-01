import * as alb from "@distilled.cloud/stackit/alb";
import * as Layer from "effect/Layer";
import { makeScopeHttpBinding } from "../LoadBalancer/BindingHttp.ts";
import { ListCredentials } from "./ListCredentials.ts";

/**
 * HTTP implementation of {@link ListCredentials}.
 *
 * @layer
 * @provides Stackit.ALB.ListCredentials
 */
export const ListCredentialsHttp = Layer.effect(
  ListCredentials,
  makeScopeHttpBinding({
    tag: "Stackit.ALB.ListCredentials",
    access: { permissions: ["alb.credentials.list"] },
    operation: alb.listCredentials,
  }),
);
