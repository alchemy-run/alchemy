import * as route53 from "@distilled.cloud/aws/route-53";
import * as Layer from "effect/Layer";
import { makeRoute53AccountHttpBinding } from "./BindingHttp.ts";
import { ListHostedZonesByVPC } from "./ListHostedZonesByVPC.ts";

export const ListHostedZonesByVPCHttp = Layer.effect(
  ListHostedZonesByVPC,
  makeRoute53AccountHttpBinding({
    tag: "AWS.Route53.ListHostedZonesByVPC",
    operation: route53.listHostedZonesByVPC,
    actions: ["route53:ListHostedZonesByVPC"],
  }),
);
