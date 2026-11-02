import * as ipLists from "@distilled.cloud/stackit/lb_ip_lists";
import * as Layer from "effect/Layer";
import { makeScopeHttpBinding } from "../LoadBalancer/BindingHttp.ts";
import { GetQuota } from "./GetQuota.ts";

/**
 * HTTP implementation of {@link GetQuota}.
 *
 * @layer
 * @provides Stackit.IPLists.GetQuota
 */
export const GetQuotaHttp = Layer.effect(
  GetQuota,
  makeScopeHttpBinding({
    tag: "Stackit.IPLists.GetQuota",
    access: { permissions: ["lb-ip-lists.quota.get"] },
    operation: ipLists.getQuota,
  }),
);
