import * as lb from "@distilled.cloud/stackit/load_balancer";
import * as Layer from "effect/Layer";
import { makeScopeHttpBinding } from "./BindingHttp.ts";
import { ListCredentials } from "./ListCredentials.ts";

/**
 * HTTP implementation of {@link ListCredentials}.
 *
 * @layer
 * @provides Stackit.LoadBalancer.ListCredentials
 */
export const ListCredentialsHttp = Layer.effect(
  ListCredentials,
  makeScopeHttpBinding({
    tag: "Stackit.LoadBalancer.ListCredentials",
    access: { permissions: ["nlb.credentials.list"] },
    operation: lb.listCredentials,
  }),
);
