import * as Layer from "effect/Layer";
import { makeHttpDnsBinding } from "./DnsBinding.ts";
import { WriteDns, dnsWriteClient } from "./WriteDns.ts";

/** Runtime layer for {@link WriteDns}. */
export const WriteDnsBinding = Layer.effect(
  WriteDns,
  makeHttpDnsBinding({
    permissionGroups: ["DNS Write"],
    makeClient: dnsWriteClient,
  }),
);
