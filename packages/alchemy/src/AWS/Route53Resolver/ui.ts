import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { ResolverEndpoint } from "./ResolverEndpoint.ts";
import type { ResolverRule } from "./ResolverRule.ts";
import type { ResolverRuleAssociation } from "./ResolverRuleAssociation.ts";

/**
 * Dashboard UI providers for AWS Route53Resolver resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Networking & Content Delivery brand purple. */
const COLOR = "#8C4FFF";

export const ResolverEndpointUI = UIProvider.succeed<ResolverEndpoint>(
  "AWS.Route53Resolver.ResolverEndpoint",
  {
    displayName: "Resolver Endpoint",
    icon: "route",
    color: COLOR,
    category: "dns",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "endpoint id",
        value: ctx.attrs?.resolverEndpointId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.resolverEndpointArn,
        mono: true,
        copy: true,
      },
      { label: "direction", value: ctx.attrs?.direction },
      { label: "vpc", value: ctx.attrs?.hostVpcId, mono: true },
    ],
  },
);

export const ResolverRuleUI = UIProvider.succeed<ResolverRule>(
  "AWS.Route53Resolver.ResolverRule",
  {
    displayName: "Resolver Rule",
    icon: "filter",
    color: COLOR,
    category: "dns",
    summary: (ctx) => ctx.attrs?.domainName ?? ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "domain", value: ctx.attrs?.domainName, mono: true },
      {
        label: "rule id",
        value: ctx.attrs?.resolverRuleId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.resolverRuleArn,
        mono: true,
        copy: true,
      },
      { label: "type", value: ctx.props?.ruleType },
    ],
  },
);

export const ResolverRuleAssociationUI =
  UIProvider.succeed<ResolverRuleAssociation>(
    "AWS.Route53Resolver.ResolverRuleAssociation",
    {
      displayName: "Resolver Rule Association",
      icon: "link-2",
      color: COLOR,
      category: "dns",
      summary: (ctx) => ctx.attrs?.resolverRuleAssociationId,
      facts: (ctx) => [
        {
          label: "association id",
          value: ctx.attrs?.resolverRuleAssociationId,
          mono: true,
          copy: true,
        },
        { label: "rule", value: ctx.attrs?.resolverRuleId, mono: true },
        { label: "vpc", value: ctx.attrs?.vpcId, mono: true },
      ],
    },
  );

export const ui = () =>
  Layer.mergeAll(ResolverEndpointUI, ResolverRuleUI, ResolverRuleAssociationUI);
