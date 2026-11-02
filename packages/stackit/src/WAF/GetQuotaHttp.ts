import * as waf from "@distilled.cloud/stackit/alb_waf";
import * as Layer from "effect/Layer";
import { makeScopeHttpBinding } from "../LoadBalancer/BindingHttp.ts";
import { GetQuota } from "./GetQuota.ts";

/**
 * HTTP implementation of {@link GetQuota}.
 *
 * @layer
 * @provides Stackit.WAF.GetQuota
 */
export const GetQuotaHttp = Layer.effect(
  GetQuota,
  makeScopeHttpBinding({
    tag: "Stackit.WAF.GetQuota",
    access: { permissions: ["alb.waf.quota.get"] },
    operation: waf.getQuota,
  }),
);
