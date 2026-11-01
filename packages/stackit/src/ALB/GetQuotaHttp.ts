import * as alb from "@distilled.cloud/stackit/alb";
import * as Layer from "effect/Layer";
import { makeScopeHttpBinding } from "../LoadBalancer/BindingHttp.ts";
import { GetQuota } from "./GetQuota.ts";

/**
 * HTTP implementation of {@link GetQuota}.
 *
 * @layer
 * @provides Stackit.ALB.GetQuota
 */
export const GetQuotaHttp = Layer.effect(
  GetQuota,
  makeScopeHttpBinding({
    tag: "Stackit.ALB.GetQuota",
    access: { permissions: ["alb.quota.get"] },
    operation: alb.getQuota,
  }),
);
