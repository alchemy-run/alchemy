import * as dns from "@distilled.cloud/stackit/dns";
import * as Layer from "effect/Layer";
import { DNS_WRITE_ACCESS, makeZoneHttpBinding } from "./BindingHttp.ts";
import { DeleteRecordSet } from "./DeleteRecordSet.ts";

/**
 * HTTP implementation of {@link DeleteRecordSet}.
 *
 * @layer
 * @provides Stackit.DNS.DeleteRecordSet
 */
export const DeleteRecordSetHttp = Layer.effect(
  DeleteRecordSet,
  makeZoneHttpBinding({
    tag: "Stackit.DNS.DeleteRecordSet",
    access: DNS_WRITE_ACCESS,
    operation: dns.deleteRecordSet,
  }),
);
