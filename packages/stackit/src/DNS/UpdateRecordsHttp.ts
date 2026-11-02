import * as dns from "@distilled.cloud/stackit/dns";
import * as Layer from "effect/Layer";
import { DNS_WRITE_ACCESS, makeZoneHttpBinding } from "./BindingHttp.ts";
import { UpdateRecords } from "./UpdateRecords.ts";

/**
 * HTTP implementation of {@link UpdateRecords}.
 *
 * @layer
 * @provides Stackit.DNS.UpdateRecords
 */
export const UpdateRecordsHttp = Layer.effect(
  UpdateRecords,
  makeZoneHttpBinding({
    tag: "Stackit.DNS.UpdateRecords",
    access: DNS_WRITE_ACCESS,
    operation: dns.partialUpdateRecord,
  }),
);
