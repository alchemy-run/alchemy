import * as certificates from "@distilled.cloud/stackit/certificates";
import * as Layer from "effect/Layer";
import { makeScopeHttpBinding } from "./BindingHttp.ts";
import { GetQuota } from "./GetQuota.ts";

/**
 * HTTP implementation of {@link GetQuota}.
 *
 * @layer
 * @provides Stackit.Certificates.GetQuota
 */
export const GetQuotaHttp = Layer.effect(
  GetQuota,
  makeScopeHttpBinding({
    tag: "Stackit.Certificates.GetQuota",
    permission: "alb.certificateservice.quota.get",
    operation: certificates.getQuota,
  }),
);
