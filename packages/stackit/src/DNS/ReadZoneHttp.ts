import * as Layer from "effect/Layer";
import { DNS_READ_ACCESS, makeReadZoneClient, makeZoneClientHttpBinding } from "./BindingHttp.ts";
import { ReadZone } from "./ReadZone.ts";

/**
 * HTTP implementation of {@link ReadZone}.
 *
 * @layer
 * @provides Stackit.DNS.ReadZone
 */
export const ReadZoneHttp = Layer.effect(
  ReadZone,
  makeZoneClientHttpBinding({
    tag: "Stackit.DNS.ReadZone",
    access: DNS_READ_ACCESS,
    makeClient: makeReadZoneClient,
  }),
);
