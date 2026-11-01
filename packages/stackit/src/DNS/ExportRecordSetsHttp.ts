import * as dns from "@distilled.cloud/stackit/dns";
import * as Layer from "effect/Layer";
import { DNS_READ_ACCESS, makeZoneHttpBinding } from "./BindingHttp.ts";
import { ExportRecordSets } from "./ExportRecordSets.ts";

/**
 * HTTP implementation of {@link ExportRecordSets}.
 *
 * @layer
 * @provides Stackit.DNS.ExportRecordSets
 */
export const ExportRecordSetsHttp = Layer.effect(
  ExportRecordSets,
  makeZoneHttpBinding({
    tag: "Stackit.DNS.ExportRecordSets",
    access: DNS_READ_ACCESS,
    operation: dns.exportRecordSets,
  }),
);
