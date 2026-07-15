import * as route53domains from "@distilled.cloud/aws/route-53-domains";
import * as Layer from "effect/Layer";
import { makeRoute53DomainsHttpBinding } from "./BindingHttp.ts";
import { RetrieveDomainAuthCode } from "./RetrieveDomainAuthCode.ts";

export const RetrieveDomainAuthCodeHttp = Layer.effect(
  RetrieveDomainAuthCode,
  makeRoute53DomainsHttpBinding<
    route53domains.RetrieveDomainAuthCodeRequest,
    route53domains.RetrieveDomainAuthCodeResponse,
    route53domains.RetrieveDomainAuthCodeError
  >({
    capability: "RetrieveDomainAuthCode",
    iamActions: ["route53domains:RetrieveDomainAuthCode"],
    operation: route53domains.retrieveDomainAuthCode,
  }),
);
