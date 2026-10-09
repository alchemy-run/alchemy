import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Capability } from "./Capability.ts";
import type { Partnership } from "./Partnership.ts";
import type { Profile } from "./Profile.ts";
import type { Transformer } from "./Transformer.ts";

/**
 * Dashboard UI providers for AWS B2BI resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const CapabilityUI = UIProvider.succeed<Capability>(
  "AWS.B2BI.Capability",
  {
    displayName: "B2BI Capability",
    icon: "workflow",
    color: "#E7157B",
    category: "eventing",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.capabilityArn,
        mono: true,
        copy: true,
      },
      { label: "id", value: ctx.attrs?.capabilityId, mono: true },
      { label: "type", value: ctx.attrs?.type },
    ],
  },
);

export const PartnershipUI = UIProvider.succeed<Partnership>(
  "AWS.B2BI.Partnership",
  {
    displayName: "B2BI Partnership",
    icon: "share-2",
    color: "#E7157B",
    category: "eventing",
    summary: (ctx) => ctx.props?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.props?.name, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.partnershipArn,
        mono: true,
        copy: true,
      },
      { label: "id", value: ctx.attrs?.partnershipId, mono: true },
      { label: "profile", value: ctx.attrs?.profileId, mono: true },
      {
        label: "trading partner",
        value: ctx.attrs?.tradingPartnerId,
        mono: true,
      },
    ],
  },
);

export const ProfileUI = UIProvider.succeed<Profile>("AWS.B2BI.Profile", {
  displayName: "B2BI Profile",
  icon: "briefcase",
  color: "#E7157B",
  category: "eventing",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "arn", value: ctx.attrs?.profileArn, mono: true, copy: true },
    { label: "id", value: ctx.attrs?.profileId, mono: true },
    { label: "business", value: ctx.attrs?.businessName },
    { label: "log group", value: ctx.attrs?.logGroupName, mono: true },
  ],
});

export const TransformerUI = UIProvider.succeed<Transformer>(
  "AWS.B2BI.Transformer",
  {
    displayName: "B2BI Transformer",
    icon: "repeat",
    color: "#E7157B",
    category: "eventing",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.transformerArn,
        mono: true,
        copy: true,
      },
      { label: "id", value: ctx.attrs?.transformerId, mono: true },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(CapabilityUI, PartnershipUI, ProfileUI, TransformerUI);
