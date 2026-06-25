import * as Layer from "effect/Layer";
import { makeHttpDnsBinding } from "./DnsBinding.ts";
import { ReadDns, dnsReadClient } from "./ReadDns.ts";

/** Runtime layer for {@link ReadDns}. */
export const ReadDnsBinding = Layer.effect(
  ReadDns,
  makeHttpDnsBinding({
    permissionGroups: ["DNS Read"],
    makeClient: dnsReadClient,
  }),
);
