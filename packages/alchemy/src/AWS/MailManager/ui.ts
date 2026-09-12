import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AddonInstance } from "./AddonInstance.ts";
import type { AddonSubscription } from "./AddonSubscription.ts";
import type { AddressList } from "./AddressList.ts";
import type { Archive } from "./Archive.ts";
import type { IngressPoint } from "./IngressPoint.ts";
import type { Relay } from "./Relay.ts";
import type { RuleSet } from "./RuleSet.ts";
import type { TrafficPolicy } from "./TrafficPolicy.ts";

/**
 * Dashboard UI providers for AWS MailManager resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const AddonInstanceUI = UIProvider.succeed<AddonInstance>(
  "AWS.MailManager.AddonInstance",
  {
    displayName: "Mail Manager Add On Instance",
    icon: "plug",
    color: "#E7157B",
    category: "email",
    summary: (ctx) => ctx.attrs?.addonName ?? ctx.attrs?.addonInstanceId,
    facts: (ctx) => [
      {
        label: "id",
        value: ctx.attrs?.addonInstanceId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.addonInstanceArn,
        mono: true,
        copy: true,
      },
      { label: "add on", value: ctx.attrs?.addonName },
      {
        label: "subscription",
        value: ctx.attrs?.addonSubscriptionId,
        mono: true,
      },
    ],
  },
);

export const AddonSubscriptionUI = UIProvider.succeed<AddonSubscription>(
  "AWS.MailManager.AddonSubscription",
  {
    displayName: "Mail Manager Add On Subscription",
    icon: "package",
    color: "#E7157B",
    category: "email",
    summary: (ctx) => ctx.attrs?.addonName,
    facts: (ctx) => [
      { label: "add on", value: ctx.attrs?.addonName, copy: true },
      {
        label: "id",
        value: ctx.attrs?.addonSubscriptionId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.addonSubscriptionArn,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const AddressListUI = UIProvider.succeed<AddressList>(
  "AWS.MailManager.AddressList",
  {
    displayName: "Mail Manager Address List",
    icon: "list-ordered",
    color: "#E7157B",
    category: "email",
    summary: (ctx) => ctx.attrs?.addressListName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.addressListName, copy: true },
      {
        label: "id",
        value: ctx.attrs?.addressListId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.addressListArn,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const ArchiveUI = UIProvider.succeed<Archive>(
  "AWS.MailManager.Archive",
  {
    displayName: "Mail Manager Archive",
    icon: "archive",
    color: "#E7157B",
    category: "email",
    summary: (ctx) => ctx.attrs?.archiveName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.archiveName, copy: true },
      { label: "id", value: ctx.attrs?.archiveId, mono: true, copy: true },
      { label: "arn", value: ctx.attrs?.archiveArn, mono: true, copy: true },
      { label: "state", value: ctx.attrs?.archiveState },
      { label: "retention", value: ctx.props?.retentionPeriod },
    ],
  },
);

export const IngressPointUI = UIProvider.succeed<IngressPoint>(
  "AWS.MailManager.IngressPoint",
  {
    displayName: "Mail Manager Ingress Point",
    icon: "inbox",
    color: "#E7157B",
    category: "email",
    summary: (ctx) => ctx.attrs?.ingressPointName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.ingressPointName, copy: true },
      {
        label: "id",
        value: ctx.attrs?.ingressPointId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.ingressPointArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      { label: "a record", value: ctx.attrs?.aRecord, mono: true, copy: true },
      { label: "type", value: ctx.props?.type },
    ],
  },
);

export const RelayUI = UIProvider.succeed<Relay>("AWS.MailManager.Relay", {
  displayName: "Mail Manager Relay",
  icon: "send",
  color: "#E7157B",
  category: "email",
  summary: (ctx) => ctx.attrs?.relayName,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.relayName, copy: true },
    { label: "id", value: ctx.attrs?.relayId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.relayArn, mono: true, copy: true },
    { label: "server", value: ctx.props?.serverName, mono: true },
    { label: "port", value: ctx.props?.serverPort },
  ],
});

export const RuleSetUI = UIProvider.succeed<RuleSet>(
  "AWS.MailManager.RuleSet",
  {
    displayName: "Mail Manager Rule Set",
    icon: "filter",
    color: "#E7157B",
    category: "email",
    summary: (ctx) => ctx.attrs?.ruleSetName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.ruleSetName, copy: true },
      { label: "id", value: ctx.attrs?.ruleSetId, mono: true, copy: true },
      { label: "arn", value: ctx.attrs?.ruleSetArn, mono: true, copy: true },
      { label: "rules", value: ctx.props?.rules?.length },
    ],
  },
);

export const TrafficPolicyUI = UIProvider.succeed<TrafficPolicy>(
  "AWS.MailManager.TrafficPolicy",
  {
    displayName: "Mail Manager Traffic Policy",
    icon: "scale",
    color: "#E7157B",
    category: "email",
    summary: (ctx) => ctx.attrs?.trafficPolicyName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.trafficPolicyName, copy: true },
      {
        label: "id",
        value: ctx.attrs?.trafficPolicyId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.trafficPolicyArn,
        mono: true,
        copy: true,
      },
      { label: "default action", value: ctx.props?.defaultAction },
      { label: "max message size", value: ctx.props?.maxMessageSizeBytes },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    AddonInstanceUI,
    AddonSubscriptionUI,
    AddressListUI,
    ArchiveUI,
    IngressPointUI,
    RelayUI,
    RuleSetUI,
    TrafficPolicyUI,
  );
