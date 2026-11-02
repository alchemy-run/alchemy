import * as dns from "@distilled.cloud/stackit/dns";
import * as Layer from "effect/Layer";
import { DNS_WRITE_ACCESS, makeZoneHttpBinding } from "./BindingHttp.ts";
import { ImportRecordSets } from "./ImportRecordSets.ts";

/**
 * HTTP implementation of {@link ImportRecordSets}.
 *
 * @layer
 * @provides Stackit.DNS.ImportRecordSets
 */
export const ImportRecordSetsHttp = Layer.effect(
  ImportRecordSets,
  makeZoneHttpBinding({
    tag: "Stackit.DNS.ImportRecordSets",
    access: DNS_WRITE_ACCESS,
    operation: dns.importRecordSets,
  }),
);
