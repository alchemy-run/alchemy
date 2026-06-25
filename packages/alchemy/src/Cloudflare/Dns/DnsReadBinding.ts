import * as Layer from "effect/Layer";
import { makeHttpDnsBinding } from "./DnsBinding.ts";
import { DnsRead, dnsReadClient } from "./DnsRead.ts";

/** Runtime layer for {@link DnsRead}. */
export const DnsReadBinding = Layer.effect(
  DnsRead,
  makeHttpDnsBinding({
    permissionGroups: ["DNS Read"],
    makeClient: dnsReadClient,
  }),
);
