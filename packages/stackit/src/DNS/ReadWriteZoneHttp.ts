import * as Layer from "effect/Layer";
import {
  DNS_WRITE_ACCESS,
  makeReadWriteZoneClient,
  makeZoneClientHttpBinding,
} from "./BindingHttp.ts";
import { ReadWriteZone } from "./ReadWriteZone.ts";

/**
 * HTTP implementation of {@link ReadWriteZone}.
 *
 * @layer
 * @provides Stackit.DNS.ReadWriteZone
 */
export const ReadWriteZoneHttp = Layer.effect(
  ReadWriteZone,
  makeZoneClientHttpBinding({
    tag: "Stackit.DNS.ReadWriteZone",
    access: DNS_WRITE_ACCESS,
    makeClient: makeReadWriteZoneClient,
  }),
);
