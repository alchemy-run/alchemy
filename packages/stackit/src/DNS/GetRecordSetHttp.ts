import * as dns from "@distilled.cloud/stackit/dns";
import * as Layer from "effect/Layer";
import { DNS_READ_ACCESS, makeZoneHttpBinding } from "./BindingHttp.ts";
import { GetRecordSet } from "./GetRecordSet.ts";

/**
 * HTTP implementation of {@link GetRecordSet}.
 *
 * @layer
 * @provides Stackit.DNS.GetRecordSet
 */
export const GetRecordSetHttp = Layer.effect(
  GetRecordSet,
  makeZoneHttpBinding({
    tag: "Stackit.DNS.GetRecordSet",
    access: DNS_READ_ACCESS,
    operation: dns.getRecordSet,
  }),
);
