import * as dns from "@distilled.cloud/stackit/dns";
import * as Layer from "effect/Layer";
import { DNS_WRITE_ACCESS, makeZoneHttpBinding } from "./BindingHttp.ts";
import { RetrieveZone } from "./RetrieveZone.ts";

/**
 * HTTP implementation of {@link RetrieveZone}.
 *
 * @layer
 * @provides Stackit.DNS.RetrieveZone
 */
export const RetrieveZoneHttp = Layer.effect(
  RetrieveZone,
  makeZoneHttpBinding({
    tag: "Stackit.DNS.RetrieveZone",
    access: DNS_WRITE_ACCESS,
    operation: dns.retrieveZone,
  }),
);
