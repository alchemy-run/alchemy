import * as route53domains from "@distilled.cloud/aws/route-53-domains";
import * as Layer from "effect/Layer";
import { makeRoute53DomainsHttpBinding } from "./BindingHttp.ts";
import { CheckDomainAvailability } from "./CheckDomainAvailability.ts";

export const CheckDomainAvailabilityHttp = Layer.effect(
  CheckDomainAvailability,
  makeRoute53DomainsHttpBinding<
    route53domains.CheckDomainAvailabilityRequest,
    route53domains.CheckDomainAvailabilityResponse,
    route53domains.CheckDomainAvailabilityError
  >({
    capability: "CheckDomainAvailability",
    iamActions: ["route53domains:CheckDomainAvailability"],
    operation: route53domains.checkDomainAvailability,
  }),
);
