import * as Layer from "effect/Layer";
import { makeHttpDnsBinding } from "./DnsBinding.ts";
import { ReadWriteDns, dnsReadWriteClient } from "./ReadWriteDns.ts";

/** Runtime layer for {@link ReadWriteDns}. */
export const ReadWriteDnsBinding = Layer.effect(
  ReadWriteDns,
  makeHttpDnsBinding({
    permissionGroups: ["DNS Read", "DNS Write"],
    makeClient: dnsReadWriteClient,
  }),
);
