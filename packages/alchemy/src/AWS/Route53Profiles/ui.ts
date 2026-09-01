import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Profile } from "./Profile.ts";
import type { ProfileAssociation } from "./ProfileAssociation.ts";
import type { ProfileResourceAssociation } from "./ProfileResourceAssociation.ts";

/**
 * Dashboard UI providers for AWS Route 53 Profiles resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** Route 53 brand color (AWS Networking & Content Delivery purple). */
const ROUTE53_PROFILES_COLOR = "#8C4FFF";

export const ProfileUI = UIProvider.succeed<Profile>(
  "AWS.Route53Profiles.Profile",
  {
    displayName: "Route 53 Profile",
    icon: "route",
    color: ROUTE53_PROFILES_COLOR,
    category: "dns",
    summary: (ctx) => ctx.attrs?.profileName,
    facts: (ctx) => [
      { label: "profile", value: ctx.attrs?.profileName, copy: true },
      { label: "id", value: ctx.attrs?.profileId, mono: true, copy: true },
      { label: "arn", value: ctx.attrs?.profileArn, mono: true, copy: true },
    ],
  },
);

export const ProfileAssociationUI = UIProvider.succeed<ProfileAssociation>(
  "AWS.Route53Profiles.ProfileAssociation",
  {
    displayName: "Route 53 Profile Association",
    icon: "link",
    color: ROUTE53_PROFILES_COLOR,
    category: "dns",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      {
        label: "association",
        value: ctx.attrs?.profileAssociationId,
        mono: true,
        copy: true,
      },
      { label: "profile", value: ctx.attrs?.profileId, mono: true },
      { label: "vpc", value: ctx.attrs?.resourceId, mono: true, copy: true },
      { label: "name", value: ctx.attrs?.name },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const ProfileResourceAssociationUI =
  UIProvider.succeed<ProfileResourceAssociation>(
    "AWS.Route53Profiles.ProfileResourceAssociation",
    {
      displayName: "Route 53 Profile Resource Association",
      icon: "cable",
      color: ROUTE53_PROFILES_COLOR,
      category: "dns",
      summary: (ctx) => ctx.attrs?.name,
      facts: (ctx) => [
        {
          label: "association",
          value: ctx.attrs?.profileResourceAssociationId,
          mono: true,
          copy: true,
        },
        { label: "profile", value: ctx.attrs?.profileId, mono: true },
        {
          label: "resource arn",
          value: ctx.attrs?.resourceArn,
          mono: true,
          copy: true,
        },
        { label: "resource type", value: ctx.attrs?.resourceType },
        { label: "name", value: ctx.attrs?.name },
        { label: "status", value: ctx.attrs?.status },
      ],
    },
  );

export const ui = () =>
  Layer.mergeAll(ProfileUI, ProfileAssociationUI, ProfileResourceAssociationUI);
