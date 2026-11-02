import * as dns from "@distilled.cloud/stackit/dns";
import * as Layer from "effect/Layer";
import { DNS_READ_ACCESS, makeZoneHttpBinding } from "./BindingHttp.ts";
import { ListRecordSets } from "./ListRecordSets.ts";

/**
 * HTTP implementation of {@link ListRecordSets}.
 *
 * @layer
 * @provides Stackit.DNS.ListRecordSets
 */
export const ListRecordSetsHttp = Layer.effect(
  ListRecordSets,
  makeZoneHttpBinding({
    tag: "Stackit.DNS.ListRecordSets",
    access: DNS_READ_ACCESS,
    operation: dns.listRecordSets,
  }),
);
