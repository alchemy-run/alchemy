import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AccountDnsSettings } from "./AccountSettings.ts";
import type { Dnssec } from "./Dnssec.ts";
import type { Firewall } from "./Firewall.ts";
import type { Record } from "./Record.ts";
import type { View } from "./View.ts";
import type { ZoneDnsSettings } from "./ZoneSettings.ts";
import type { ZoneTransferAcl } from "./ZoneTransferAcl.ts";
import type { ZoneTransferIncoming } from "./ZoneTransferIncoming.ts";
import type { ZoneTransferOutgoing } from "./ZoneTransferOutgoing.ts";
import type { ZoneTransferPeer } from "./ZoneTransferPeer.ts";
import type { ZoneTransferTsig } from "./ZoneTransferTsig.ts";

/**
 * Dashboard UI providers for Cloudflare DNS resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const RecordUI = UIProvider.succeed<Record>("Cloudflare.DNS.Record", {
  displayName: "DNS Record",
  icon: "globe",
  color: "#F6821F",
  category: "dns",
  summary: (ctx) =>
    ctx.attrs?.name === undefined
      ? undefined
      : `${ctx.attrs.type ?? ""} ${ctx.attrs.name}`.trim(),
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "type", value: ctx.attrs?.type, mono: true },
    { label: "content", value: ctx.attrs?.content, mono: true, copy: true },
    { label: "ttl", value: ctx.attrs?.ttl },
    { label: "proxied", value: ctx.attrs?.proxied },
    { label: "record id", value: ctx.attrs?.recordId, mono: true, copy: true },
    { label: "zone id", value: ctx.attrs?.zoneId, mono: true, copy: true },
  ],
});

export const DnssecUI = UIProvider.succeed<Dnssec>("Cloudflare.DNS.Dnssec", {
  displayName: "DNSSEC",
  icon: "shield-check",
  color: "#F6821F",
  category: "dns",
  summary: (ctx) => ctx.attrs?.status,
  facts: (ctx) => [
    { label: "status", value: ctx.attrs?.status },
    { label: "zone id", value: ctx.attrs?.zoneId, mono: true, copy: true },
    { label: "algorithm", value: ctx.attrs?.algorithm, mono: true },
    { label: "key tag", value: ctx.attrs?.keyTag, mono: true },
    { label: "digest type", value: ctx.attrs?.digestType, mono: true },
    { label: "ds", value: ctx.attrs?.ds, mono: true, copy: true },
    { label: "multi-signer", value: ctx.attrs?.dnssecMultiSigner },
    { label: "presigned", value: ctx.attrs?.dnssecPresigned },
  ],
});

export const FirewallUI = UIProvider.succeed<Firewall>(
  "Cloudflare.DNS.Firewall",
  {
    displayName: "DNS Firewall",
    icon: "shield",
    color: "#F6821F",
    category: "dns",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "firewall id",
        value: ctx.attrs?.dnsFirewallId,
        mono: true,
        copy: true,
      },
      {
        label: "firewall ips",
        value: ctx.attrs?.dnsFirewallIps?.length
          ? ctx.attrs.dnsFirewallIps.join(", ")
          : undefined,
        mono: true,
        copy: true,
      },
      {
        label: "upstream ips",
        value: ctx.attrs?.upstreamIps?.length
          ? ctx.attrs.upstreamIps.join(", ")
          : undefined,
        mono: true,
      },
      { label: "max cache ttl", value: ctx.attrs?.maximumCacheTtl },
      { label: "retries", value: ctx.attrs?.retries },
      {
        label: "account id",
        value: ctx.attrs?.accountId,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const ViewUI = UIProvider.succeed<View>("Cloudflare.DNS.View", {
  displayName: "DNS Internal View",
  icon: "eye",
  color: "#F6821F",
  category: "dns",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "view id", value: ctx.attrs?.viewId, mono: true, copy: true },
    {
      label: "zones",
      value: ctx.attrs?.zones?.length ? ctx.attrs.zones.join(", ") : undefined,
      mono: true,
    },
    {
      label: "account id",
      value: ctx.attrs?.accountId,
      mono: true,
      copy: true,
    },
  ],
});

export const AccountDnsSettingsUI = UIProvider.succeed<AccountDnsSettings>(
  "Cloudflare.DNS.AccountSettings",
  {
    displayName: "Account DNS Settings",
    icon: "settings-2",
    color: "#F6821F",
    category: "config",
    summary: (ctx) => ctx.attrs?.accountId,
    facts: (ctx) => [
      {
        label: "account id",
        value: ctx.attrs?.accountId,
        mono: true,
        copy: true,
      },
      { label: "enforce dns only", value: ctx.attrs?.enforceDnsOnly },
      {
        label: "managed keys",
        value: ctx.attrs?.managedKeys?.length
          ? ctx.attrs.managedKeys.join(", ")
          : undefined,
        mono: true,
      },
    ],
  },
);

export const ZoneDnsSettingsUI = UIProvider.succeed<ZoneDnsSettings>(
  "Cloudflare.DNS.ZoneSettings",
  {
    displayName: "Zone DNS Settings",
    icon: "settings",
    color: "#F6821F",
    category: "config",
    summary: (ctx) => ctx.attrs?.zoneId,
    facts: (ctx) => [
      { label: "zone id", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "zone mode", value: ctx.attrs?.zoneMode },
      { label: "multi-provider", value: ctx.attrs?.multiProvider },
      { label: "flatten all cnames", value: ctx.attrs?.flattenAllCnames },
      { label: "foundation dns", value: ctx.attrs?.foundationDns },
      { label: "ns ttl", value: ctx.attrs?.nsTtl },
      {
        label: "managed keys",
        value: ctx.attrs?.managedKeys?.length
          ? ctx.attrs.managedKeys.join(", ")
          : undefined,
        mono: true,
      },
    ],
  },
);

export const ZoneTransferAclUI = UIProvider.succeed<ZoneTransferAcl>(
  "Cloudflare.DNS.ZoneTransferAcl",
  {
    displayName: "Zone Transfer ACL",
    icon: "list-checks",
    color: "#F6821F",
    category: "dns",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "acl id", value: ctx.attrs?.aclId, mono: true, copy: true },
      { label: "ip range", value: ctx.attrs?.ipRange, mono: true, copy: true },
      {
        label: "account id",
        value: ctx.attrs?.accountId,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const ZoneTransferIncomingUI = UIProvider.succeed<ZoneTransferIncoming>(
  "Cloudflare.DNS.ZoneTransferIncoming",
  {
    displayName: "Incoming Zone Transfer",
    icon: "arrow-down-to-line",
    color: "#F6821F",
    category: "dns",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "zone id", value: ctx.attrs?.zoneId, mono: true, copy: true },
      {
        label: "peers",
        value: ctx.attrs?.peers?.length
          ? ctx.attrs.peers.join(", ")
          : undefined,
        mono: true,
      },
      { label: "auto refresh (s)", value: ctx.attrs?.autoRefreshSeconds },
      { label: "soa serial", value: ctx.attrs?.soaSerial, mono: true },
      { label: "last checked", value: ctx.attrs?.checkedTime },
    ],
  },
);

export const ZoneTransferOutgoingUI = UIProvider.succeed<ZoneTransferOutgoing>(
  "Cloudflare.DNS.ZoneTransferOutgoing",
  {
    displayName: "Outgoing Zone Transfer",
    icon: "arrow-up-from-line",
    color: "#F6821F",
    category: "dns",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "zone id", value: ctx.attrs?.zoneId, mono: true, copy: true },
      {
        label: "peers",
        value: ctx.attrs?.peers?.length
          ? ctx.attrs.peers.join(", ")
          : undefined,
        mono: true,
      },
      { label: "enabled", value: ctx.attrs?.enabled },
      { label: "soa serial", value: ctx.attrs?.soaSerial, mono: true },
      { label: "last transferred", value: ctx.attrs?.lastTransferredTime },
    ],
  },
);

export const ZoneTransferPeerUI = UIProvider.succeed<ZoneTransferPeer>(
  "Cloudflare.DNS.ZoneTransferPeer",
  {
    displayName: "Zone Transfer Peer",
    icon: "network",
    color: "#F6821F",
    category: "dns",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "peer id", value: ctx.attrs?.peerId, mono: true, copy: true },
      { label: "ip", value: ctx.attrs?.ip, mono: true, copy: true },
      { label: "port", value: ctx.attrs?.port, mono: true },
      { label: "tsig id", value: ctx.attrs?.tsigId, mono: true, copy: true },
      { label: "ixfr enabled", value: ctx.attrs?.ixfrEnable },
      {
        label: "account id",
        value: ctx.attrs?.accountId,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const ZoneTransferTsigUI = UIProvider.succeed<ZoneTransferTsig>(
  "Cloudflare.DNS.ZoneTransferTsig",
  {
    displayName: "Zone Transfer TSIG",
    icon: "key-round",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "tsig id", value: ctx.attrs?.tsigId, mono: true, copy: true },
      { label: "algorithm", value: ctx.attrs?.algo, mono: true },
      {
        label: "account id",
        value: ctx.attrs?.accountId,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    RecordUI,
    DnssecUI,
    FirewallUI,
    ViewUI,
    AccountDnsSettingsUI,
    ZoneDnsSettingsUI,
    ZoneTransferAclUI,
    ZoneTransferIncomingUI,
    ZoneTransferOutgoingUI,
    ZoneTransferPeerUI,
    ZoneTransferTsigUI,
  );
