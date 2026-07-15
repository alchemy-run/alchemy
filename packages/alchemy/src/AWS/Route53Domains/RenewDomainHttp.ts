import * as route53domains from "@distilled.cloud/aws/route-53-domains";
import * as Layer from "effect/Layer";
import { makeRoute53DomainsHttpBinding } from "./BindingHttp.ts";
import { RenewDomain } from "./RenewDomain.ts";

export const RenewDomainHttp = Layer.effect(
  RenewDomain,
  makeRoute53DomainsHttpBinding<
    route53domains.RenewDomainRequest,
    route53domains.RenewDomainResponse,
    route53domains.RenewDomainError
  >({
    capability: "RenewDomain",
    iamActions: ["route53domains:RenewDomain"],
    operation: route53domains.renewDomain,
  }),
);
