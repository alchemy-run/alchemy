import * as lb from "@distilled.cloud/stackit/load_balancer";
import * as Layer from "effect/Layer";
import { makeScopeHttpBinding } from "./BindingHttp.ts";
import { GetQuota } from "./GetQuota.ts";

/**
 * HTTP implementation of {@link GetQuota}.
 *
 * @layer
 * @provides Stackit.LoadBalancer.GetQuota
 */
export const GetQuotaHttp = Layer.effect(
  GetQuota,
  makeScopeHttpBinding({
    tag: "Stackit.LoadBalancer.GetQuota",
    access: { permissions: ["nlb.quota.get"] },
    operation: lb.getQuota,
  }),
);
