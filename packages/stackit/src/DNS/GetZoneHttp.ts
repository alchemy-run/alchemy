import * as dns from "@distilled.cloud/stackit/dns";
import * as Layer from "effect/Layer";
import { DNS_READ_ACCESS, makeZoneHttpBinding } from "./BindingHttp.ts";
import { GetZone } from "./GetZone.ts";

/**
 * HTTP implementation of {@link GetZone}.
 *
 * @layer
 * @provides Stackit.DNS.GetZone
 */
export const GetZoneHttp = Layer.effect(
  GetZone,
  makeZoneHttpBinding({
    tag: "Stackit.DNS.GetZone",
    access: DNS_READ_ACCESS,
    operation: dns.getZone,
  }),
);
