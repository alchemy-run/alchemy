import * as Layer from "effect/Layer";
import { DNS_WRITE_ACCESS, makeWriteZoneClient, makeZoneClientHttpBinding } from "./BindingHttp.ts";
import { WriteZone } from "./WriteZone.ts";

/**
 * HTTP implementation of {@link WriteZone}.
 *
 * @layer
 * @provides Stackit.DNS.WriteZone
 */
export const WriteZoneHttp = Layer.effect(
  WriteZone,
  makeZoneClientHttpBinding({
    tag: "Stackit.DNS.WriteZone",
    access: DNS_WRITE_ACCESS,
    makeClient: makeWriteZoneClient,
  }),
);
