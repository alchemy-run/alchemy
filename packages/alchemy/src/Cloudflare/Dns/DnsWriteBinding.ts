import * as Layer from "effect/Layer";
import { makeHttpDnsBinding } from "./DnsBinding.ts";
import { DnsWrite, dnsWriteClient } from "./DnsWrite.ts";

/** Runtime layer for {@link DnsWrite}. */
export const DnsWriteBinding = Layer.effect(
  DnsWrite,
  makeHttpDnsBinding({
    permissionGroups: ["DNS Write"],
    makeClient: dnsWriteClient,
  }),
);
