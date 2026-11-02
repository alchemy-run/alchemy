import * as cdn from "@distilled.cloud/stackit/cdn";
import * as Layer from "effect/Layer";
import { CDN_READ_ACCESS, makeCustomDomainHttpBinding } from "./BindingHttp.ts";
import { GetCustomDomain } from "./GetCustomDomain.ts";

/**
 * HTTP implementation of {@link GetCustomDomain}.
 *
 * @layer
 * @provides Stackit.CDN.GetCustomDomain
 */
export const GetCustomDomainHttp = Layer.effect(
  GetCustomDomain,
  makeCustomDomainHttpBinding({
    tag: "Stackit.CDN.GetCustomDomain",
    access: CDN_READ_ACCESS,
    operation: cdn.getCustomDomain,
  }),
);
