import * as route53domains from "@distilled.cloud/aws/route-53-domains";
import * as Layer from "effect/Layer";
import { makeRoute53DomainsHttpBinding } from "./BindingHttp.ts";
import { UpdateDomainNameservers } from "./UpdateDomainNameservers.ts";

export const UpdateDomainNameserversHttp = Layer.effect(
  UpdateDomainNameservers,
  makeRoute53DomainsHttpBinding<
    route53domains.UpdateDomainNameserversRequest,
    route53domains.UpdateDomainNameserversResponse,
    route53domains.UpdateDomainNameserversError
  >({
    capability: "UpdateDomainNameservers",
    iamActions: ["route53domains:UpdateDomainNameservers"],
    operation: route53domains.updateDomainNameservers,
  }),
);
