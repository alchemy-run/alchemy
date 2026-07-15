import * as route53domains from "@distilled.cloud/aws/route-53-domains";
import * as Layer from "effect/Layer";
import { makeRoute53DomainsHttpBinding } from "./BindingHttp.ts";
import { RegisterDomain } from "./RegisterDomain.ts";

export const RegisterDomainHttp = Layer.effect(
  RegisterDomain,
  makeRoute53DomainsHttpBinding<
    route53domains.RegisterDomainRequest,
    route53domains.RegisterDomainResponse,
    route53domains.RegisterDomainError
  >({
    capability: "RegisterDomain",
    iamActions: ["route53domains:RegisterDomain"],
    operation: route53domains.registerDomain,
  }),
);
