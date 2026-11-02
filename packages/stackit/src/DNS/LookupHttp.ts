import * as dns from "@distilled.cloud/stackit/dns";
import * as Layer from "effect/Layer";
import { makeResolverHttpBinding } from "./BindingHttp.ts";
import { Lookup } from "./Lookup.ts";

/**
 * HTTP implementation of {@link Lookup}.
 *
 * @layer
 * @provides Stackit.DNS.Lookup
 */
export const LookupHttp = Layer.effect(
  Lookup,
  makeResolverHttpBinding({ tag: "Stackit.DNS.Lookup", operation: dns.dnslookup }),
);
