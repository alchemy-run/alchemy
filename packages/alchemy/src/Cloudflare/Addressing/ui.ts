import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AddressMap } from "./AddressMap.ts";
import type { BgpPrefix } from "./BgpPrefix.ts";
import type { Prefix } from "./Prefix.ts";
import type { PrefixDelegation } from "./PrefixDelegation.ts";
import type { ServiceBinding } from "./ServiceBinding.ts";

/**
 * Dashboard UI providers for Cloudflare Addressing resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const AddressMapUI = UIProvider.succeed<AddressMap>(
  "Cloudflare.Addressing.AddressMap",
  {
    displayName: "Address Map",
    icon: "map",
    color: "#F6821F",
    category: "network",
    summary: (ctx) =>
      ctx.attrs?.defaultSni ??
      ctx.attrs?.description ??
      ctx.attrs?.addressMapId,
    facts: (ctx) => [
      {
        label: "address map id",
        value: ctx.attrs?.addressMapId,
        mono: true,
        copy: true,
      },
      { label: "enabled", value: ctx.attrs?.enabled },
      { label: "default SNI", value: ctx.attrs?.defaultSni, mono: true },
      {
        label: "ips",
        value: ctx.attrs?.ips?.length ? ctx.attrs.ips.join(", ") : undefined,
        mono: true,
      },
      { label: "memberships", value: ctx.attrs?.memberships?.length },
      { label: "description", value: ctx.attrs?.description },
      { label: "account", value: ctx.attrs?.accountId, mono: true },
    ],
  },
);

export const PrefixUI = UIProvider.succeed<Prefix>(
  "Cloudflare.Addressing.Prefix",
  {
    displayName: "IP Prefix",
    icon: "binary",
    color: "#F6821F",
    category: "network",
    summary: (ctx) => ctx.attrs?.cidr ?? ctx.props?.cidr,
    facts: (ctx) => [
      { label: "cidr", value: ctx.attrs?.cidr, mono: true, copy: true },
      {
        label: "prefix id",
        value: ctx.attrs?.prefixId,
        mono: true,
        copy: true,
      },
      { label: "asn", value: ctx.attrs?.asn, mono: true },
      { label: "approved", value: ctx.attrs?.approved },
      {
        label: "ownership validation",
        value: ctx.attrs?.ownershipValidationState,
      },
      { label: "rpki validation", value: ctx.attrs?.rpkiValidationState },
      { label: "description", value: ctx.attrs?.description },
      { label: "account", value: ctx.attrs?.accountId, mono: true },
    ],
  },
);

export const BgpPrefixUI = UIProvider.succeed<BgpPrefix>(
  "Cloudflare.Addressing.BgpPrefix",
  {
    displayName: "BGP Prefix",
    icon: "git-branch",
    color: "#F6821F",
    category: "network",
    summary: (ctx) => ctx.attrs?.cidr,
    facts: (ctx) => [
      { label: "cidr", value: ctx.attrs?.cidr, mono: true, copy: true },
      {
        label: "bgp prefix id",
        value: ctx.attrs?.bgpPrefixId,
        mono: true,
        copy: true,
      },
      { label: "prefix id", value: ctx.attrs?.prefixId, mono: true },
      { label: "asn", value: ctx.attrs?.asn, mono: true },
      { label: "advertised", value: ctx.attrs?.onDemand?.advertised },
      {
        label: "on-demand enabled",
        value: ctx.attrs?.onDemand?.onDemandEnabled,
      },
      { label: "account", value: ctx.attrs?.accountId, mono: true },
    ],
  },
);

export const PrefixDelegationUI = UIProvider.succeed<PrefixDelegation>(
  "Cloudflare.Addressing.PrefixDelegation",
  {
    displayName: "Prefix Delegation",
    icon: "share-2",
    color: "#F6821F",
    category: "network",
    summary: (ctx) => ctx.attrs?.cidr ?? ctx.props?.cidr,
    facts: (ctx) => [
      { label: "cidr", value: ctx.attrs?.cidr, mono: true, copy: true },
      {
        label: "delegation id",
        value: ctx.attrs?.delegationId,
        mono: true,
        copy: true,
      },
      { label: "prefix id", value: ctx.attrs?.prefixId, mono: true },
      {
        label: "delegated account",
        value: ctx.attrs?.delegatedAccountId,
        mono: true,
        copy: true,
      },
      { label: "account", value: ctx.attrs?.accountId, mono: true },
      { label: "created", value: ctx.attrs?.createdAt },
    ],
  },
);

export const ServiceBindingUI = UIProvider.succeed<ServiceBinding>(
  "Cloudflare.Addressing.ServiceBinding",
  {
    displayName: "Address Service Binding",
    icon: "link-2",
    color: "#F6821F",
    category: "network",
    summary: (ctx) => ctx.attrs?.serviceName ?? ctx.attrs?.cidr,
    facts: (ctx) => [
      { label: "service", value: ctx.attrs?.serviceName },
      {
        label: "binding id",
        value: ctx.attrs?.bindingId,
        mono: true,
        copy: true,
      },
      { label: "cidr", value: ctx.attrs?.cidr, mono: true, copy: true },
      { label: "service id", value: ctx.attrs?.serviceId, mono: true },
      { label: "prefix id", value: ctx.attrs?.prefixId, mono: true },
      { label: "provisioning", value: ctx.attrs?.provisioning?.state },
      { label: "account", value: ctx.attrs?.accountId, mono: true },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    AddressMapUI,
    PrefixUI,
    BgpPrefixUI,
    PrefixDelegationUI,
    ServiceBindingUI,
  );
