import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Crl } from "./Crl.ts";
import type { Profile } from "./Profile.ts";
import type { TrustAnchor } from "./TrustAnchor.ts";

/**
 * Dashboard UI providers for AWS RolesAnywhere resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const COLOR = "#DD344C";

export const TrustAnchorUI = UIProvider.succeed<TrustAnchor>(
  "AWS.RolesAnywhere.TrustAnchor",
  {
    displayName: "Roles Anywhere Trust Anchor",
    icon: "shield-check",
    color: COLOR,
    category: "auth",
    summary: (ctx) => ctx.attrs?.trustAnchorName,
    facts: (ctx) => [
      {
        label: "trust anchor",
        value: ctx.attrs?.trustAnchorName,
        copy: true,
      },
      {
        label: "id",
        value: ctx.attrs?.trustAnchorId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.trustAnchorArn,
        mono: true,
        copy: true,
      },
      { label: "enabled", value: ctx.attrs?.enabled },
    ],
  },
);

export const ProfileUI = UIProvider.succeed<Profile>(
  "AWS.RolesAnywhere.Profile",
  {
    displayName: "Roles Anywhere Profile",
    icon: "user",
    color: COLOR,
    category: "auth",
    summary: (ctx) => ctx.attrs?.profileName,
    facts: (ctx) => [
      { label: "profile", value: ctx.attrs?.profileName, copy: true },
      { label: "id", value: ctx.attrs?.profileId, mono: true, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.profileArn,
        mono: true,
        copy: true,
      },
      {
        label: "roles",
        value: ctx.attrs?.roleArns?.length
          ? ctx.attrs.roleArns.join(", ")
          : undefined,
        mono: true,
      },
      { label: "enabled", value: ctx.attrs?.enabled },
    ],
  },
);

export const CrlUI = UIProvider.succeed<Crl>("AWS.RolesAnywhere.Crl", {
  displayName: "Roles Anywhere CRL",
  icon: "shield",
  color: COLOR,
  category: "security",
  summary: (ctx) => ctx.attrs?.crlName,
  facts: (ctx) => [
    { label: "crl", value: ctx.attrs?.crlName, copy: true },
    { label: "id", value: ctx.attrs?.crlId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.crlArn, mono: true, copy: true },
    {
      label: "trust anchor",
      value: ctx.attrs?.trustAnchorArn,
      mono: true,
    },
    { label: "enabled", value: ctx.attrs?.enabled },
  ],
});

export const ui = () => Layer.mergeAll(TrustAnchorUI, ProfileUI, CrlUI);
