import * as Layer from "effect/Layer";
import { makeHttpDnsBinding } from "./DnsBinding.ts";
import { DnsReadWrite, dnsReadWriteClient } from "./DnsReadWrite.ts";

/** Runtime layer for {@link DnsReadWrite}. */
export const DnsReadWriteBinding = Layer.effect(
  DnsReadWrite,
  makeHttpDnsBinding({
    permissionGroups: ["DNS Read", "DNS Write"],
    makeClient: dnsReadWriteClient,
  }),
);
