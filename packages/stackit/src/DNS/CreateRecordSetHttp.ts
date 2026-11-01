import * as dns from "@distilled.cloud/stackit/dns";
import * as Layer from "effect/Layer";
import { DNS_WRITE_ACCESS, makeZoneHttpBinding } from "./BindingHttp.ts";
import { CreateRecordSet } from "./CreateRecordSet.ts";

/**
 * HTTP implementation of {@link CreateRecordSet}.
 *
 * @layer
 * @provides Stackit.DNS.CreateRecordSet
 */
export const CreateRecordSetHttp = Layer.effect(
  CreateRecordSet,
  makeZoneHttpBinding({
    tag: "Stackit.DNS.CreateRecordSet",
    access: DNS_WRITE_ACCESS,
    operation: dns.createRecordSet,
  }),
);
