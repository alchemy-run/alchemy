import * as dns from "@distilled.cloud/stackit/dns";
import * as Layer from "effect/Layer";
import { DNS_WRITE_ACCESS, makeZoneHttpBinding } from "./BindingHttp.ts";
import { UpdateRecordSet } from "./UpdateRecordSet.ts";

/**
 * HTTP implementation of {@link UpdateRecordSet}.
 *
 * @layer
 * @provides Stackit.DNS.UpdateRecordSet
 */
export const UpdateRecordSetHttp = Layer.effect(
  UpdateRecordSet,
  makeZoneHttpBinding({
    tag: "Stackit.DNS.UpdateRecordSet",
    access: DNS_WRITE_ACCESS,
    operation: dns.partialUpdateRecordSet,
  }),
);
