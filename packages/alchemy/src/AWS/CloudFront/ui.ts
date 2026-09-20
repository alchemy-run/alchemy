import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { CachePolicy } from "./CachePolicy.ts";
import type { Distribution } from "./Distribution.ts";
import type { Function } from "./Function.ts";
import type { Invalidation } from "./Invalidation.ts";
import type { KeyGroup } from "./KeyGroup.ts";
import type { KeyValueStore } from "./KeyValueStore.ts";
import type { KvEntries } from "./KvEntries.ts";
import type { KvRoutesUpdate } from "./KvRoutesUpdate.ts";
import type { OriginAccessControl } from "./OriginAccessControl.ts";
import type { OriginRequestPolicy } from "./OriginRequestPolicy.ts";
import type { PublicKey } from "./PublicKey.ts";
import type { RealtimeLogConfig } from "./RealtimeLogConfig.ts";
import type { ResponseHeadersPolicy } from "./ResponseHeadersPolicy.ts";
import type { VpcOrigin } from "./VpcOrigin.ts";

/**
 * Dashboard UI providers for AWS CloudFront resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** CloudFront brand color (AWS Networking & Content Delivery purple). */
const CLOUDFRONT_COLOR = "#8C4FFF";

export const DistributionUI = UIProvider.succeed<Distribution>(
  "AWS.CloudFront.Distribution",
  {
    displayName: "CloudFront Distribution",
    icon: "globe",
    color: CLOUDFRONT_COLOR,
    category: "cdn",
    summary: (ctx) => ctx.attrs?.domainName ?? ctx.attrs?.distributionId,
    link: (ctx) =>
      ctx.attrs?.domainName === undefined
        ? undefined
        : `https://${ctx.attrs.domainName}`,
    consoleUrl: (ctx) =>
      ctx.attrs?.distributionId === undefined
        ? undefined
        : `https://console.aws.amazon.com/cloudfront/v4/home#/distributions/${ctx.attrs.distributionId}`,
    facts: (ctx) => [
      { label: "id", value: ctx.attrs?.distributionId, mono: true, copy: true },
      {
        label: "domain",
        value: ctx.attrs?.domainName,
        href:
          ctx.attrs?.domainName === undefined
            ? undefined
            : `https://${ctx.attrs.domainName}`,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.distributionArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      { label: "enabled", value: ctx.attrs?.enabled },
      { label: "aliases", value: ctx.attrs?.aliases?.join(", ") },
      { label: "hosted zone", value: ctx.attrs?.hostedZoneId, mono: true },
    ],
  },
);

export const FunctionUI = UIProvider.succeed<Function>(
  "AWS.CloudFront.Function",
  {
    displayName: "CloudFront Function",
    icon: "code",
    color: CLOUDFRONT_COLOR,
    category: "compute",
    summary: (ctx) => ctx.attrs?.functionName,
    consoleUrl: (ctx) =>
      ctx.attrs?.functionName === undefined
        ? undefined
        : `https://console.aws.amazon.com/cloudfront/v4/home#/functions/${ctx.attrs.functionName}`,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.functionName, copy: true },
      { label: "arn", value: ctx.attrs?.functionArn, mono: true, copy: true },
      { label: "runtime", value: ctx.attrs?.runtime },
      { label: "stage", value: ctx.attrs?.stage },
      { label: "status", value: ctx.attrs?.status },
      { label: "kv stores", value: ctx.attrs?.keyValueStoreArns?.length },
    ],
  },
);

export const CachePolicyUI = UIProvider.succeed<CachePolicy>(
  "AWS.CloudFront.CachePolicy",
  {
    displayName: "CloudFront Cache Policy",
    icon: "timer",
    color: CLOUDFRONT_COLOR,
    category: "cdn",
    summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.cachePolicyId,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.cachePolicyId, mono: true, copy: true },
      { label: "min TTL", value: ctx.attrs?.minTTL },
      { label: "default TTL", value: ctx.attrs?.defaultTTL },
      { label: "max TTL", value: ctx.attrs?.maxTTL },
      { label: "comment", value: ctx.attrs?.comment },
    ],
  },
);

export const OriginRequestPolicyUI = UIProvider.succeed<OriginRequestPolicy>(
  "AWS.CloudFront.OriginRequestPolicy",
  {
    displayName: "CloudFront Origin Request Policy",
    icon: "arrow-right-left",
    color: CLOUDFRONT_COLOR,
    category: "cdn",
    summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.originRequestPolicyId,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "id",
        value: ctx.attrs?.originRequestPolicyId,
        mono: true,
        copy: true,
      },
      { label: "headers", value: ctx.attrs?.headersConfig?.HeaderBehavior },
      { label: "cookies", value: ctx.attrs?.cookiesConfig?.CookieBehavior },
      {
        label: "query strings",
        value: ctx.attrs?.queryStringsConfig?.QueryStringBehavior,
      },
      { label: "comment", value: ctx.attrs?.comment },
    ],
  },
);

export const ResponseHeadersPolicyUI =
  UIProvider.succeed<ResponseHeadersPolicy>(
    "AWS.CloudFront.ResponseHeadersPolicy",
    {
      displayName: "CloudFront Response Headers Policy",
      icon: "shield",
      color: CLOUDFRONT_COLOR,
      category: "cdn",
      summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.responseHeadersPolicyId,
      facts: (ctx) => [
        { label: "name", value: ctx.attrs?.name, copy: true },
        {
          label: "id",
          value: ctx.attrs?.responseHeadersPolicyId,
          mono: true,
          copy: true,
        },
        { label: "cors", value: ctx.attrs?.corsConfig !== undefined },
        {
          label: "security headers",
          value: ctx.attrs?.securityHeadersConfig !== undefined,
        },
        {
          label: "server timing",
          value: ctx.attrs?.serverTimingHeadersConfig !== undefined,
        },
        { label: "comment", value: ctx.attrs?.comment },
      ],
    },
  );

export const OriginAccessControlUI = UIProvider.succeed<OriginAccessControl>(
  "AWS.CloudFront.OriginAccessControl",
  {
    displayName: "CloudFront Origin Access Control",
    icon: "lock",
    color: CLOUDFRONT_COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.originAccessControlId,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "id",
        value: ctx.attrs?.originAccessControlId,
        mono: true,
        copy: true,
      },
      { label: "origin type", value: ctx.attrs?.originType },
      { label: "signing behavior", value: ctx.attrs?.signingBehavior },
      { label: "signing protocol", value: ctx.attrs?.signingProtocol },
      { label: "description", value: ctx.attrs?.description },
    ],
  },
);

export const PublicKeyUI = UIProvider.succeed<PublicKey>(
  "AWS.CloudFront.PublicKey",
  {
    displayName: "CloudFront Public Key",
    icon: "key-round",
    color: CLOUDFRONT_COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.publicKeyId,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.publicKeyId, mono: true, copy: true },
      {
        label: "caller reference",
        value: ctx.attrs?.callerReference,
        mono: true,
      },
      { label: "comment", value: ctx.attrs?.comment },
    ],
  },
);

export const KeyGroupUI = UIProvider.succeed<KeyGroup>(
  "AWS.CloudFront.KeyGroup",
  {
    displayName: "CloudFront Key Group",
    icon: "key",
    color: CLOUDFRONT_COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.keyGroupId,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.keyGroupId, mono: true, copy: true },
      { label: "public keys", value: ctx.attrs?.items?.length },
      { label: "comment", value: ctx.attrs?.comment },
    ],
  },
);

export const KeyValueStoreUI = UIProvider.succeed<KeyValueStore>(
  "AWS.CloudFront.KeyValueStore",
  {
    displayName: "CloudFront KeyValueStore",
    icon: "database",
    color: CLOUDFRONT_COLOR,
    category: "storage",
    summary: (ctx) =>
      ctx.attrs?.keyValueStoreName ?? ctx.attrs?.keyValueStoreId,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.keyValueStoreName, copy: true },
      {
        label: "id",
        value: ctx.attrs?.keyValueStoreId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.keyValueStoreArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      { label: "comment", value: ctx.attrs?.comment },
    ],
  },
);

export const KvEntriesUI = UIProvider.succeed<KvEntries>(
  "AWS.CloudFront.KvEntries",
  {
    displayName: "CloudFront KV Entries",
    icon: "list",
    color: CLOUDFRONT_COLOR,
    category: "storage",
    summary: (ctx) => ctx.attrs?.namespace,
    facts: (ctx) => [
      { label: "namespace", value: ctx.attrs?.namespace, mono: true },
      { label: "store", value: ctx.attrs?.store, mono: true, copy: true },
      {
        label: "entries",
        value:
          ctx.attrs?.entries === undefined
            ? undefined
            : Object.keys(ctx.attrs.entries).length,
      },
    ],
  },
);

export const KvRoutesUpdateUI = UIProvider.succeed<KvRoutesUpdate>(
  "AWS.CloudFront.KvRoutesUpdate",
  {
    displayName: "CloudFront KV Route",
    icon: "route",
    color: CLOUDFRONT_COLOR,
    category: "cdn",
    summary: (ctx) =>
      ctx.attrs?.namespace === undefined || ctx.attrs?.key === undefined
        ? undefined
        : `${ctx.attrs.namespace}:${ctx.attrs.key}`,
    facts: (ctx) => [
      { label: "namespace", value: ctx.attrs?.namespace, mono: true },
      { label: "key", value: ctx.attrs?.key, mono: true },
      { label: "entry", value: ctx.attrs?.entry, mono: true, copy: true },
      { label: "store", value: ctx.attrs?.store, mono: true, copy: true },
    ],
  },
);

export const InvalidationUI = UIProvider.succeed<Invalidation>(
  "AWS.CloudFront.Invalidation",
  {
    displayName: "CloudFront Invalidation",
    icon: "refresh-cw",
    color: CLOUDFRONT_COLOR,
    category: "cdn",
    summary: (ctx) => ctx.attrs?.invalidationId,
    consoleUrl: (ctx) =>
      ctx.attrs?.distributionId === undefined
        ? undefined
        : `https://console.aws.amazon.com/cloudfront/v4/home#/distributions/${ctx.attrs.distributionId}`,
    facts: (ctx) => [
      { label: "id", value: ctx.attrs?.invalidationId, mono: true, copy: true },
      {
        label: "distribution",
        value: ctx.attrs?.distributionId,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      { label: "version", value: ctx.attrs?.version, mono: true },
      { label: "paths", value: ctx.attrs?.paths?.join(", "), mono: true },
    ],
  },
);

export const VpcOriginUI = UIProvider.succeed<VpcOrigin>(
  "AWS.CloudFront.VpcOrigin",
  {
    displayName: "CloudFront VPC Origin",
    icon: "network",
    color: CLOUDFRONT_COLOR,
    category: "network",
    summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.vpcOriginId,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.vpcOriginId, mono: true, copy: true },
      { label: "arn", value: ctx.attrs?.vpcOriginArn, mono: true, copy: true },
      { label: "origin arn", value: ctx.attrs?.arn, mono: true, copy: true },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const RealtimeLogConfigUI = UIProvider.succeed<RealtimeLogConfig>(
  "AWS.CloudFront.RealtimeLogConfig",
  {
    displayName: "CloudFront Real-Time Log Config",
    icon: "scroll-text",
    color: CLOUDFRONT_COLOR,
    category: "cdn",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
      { label: "sampling rate", value: ctx.attrs?.samplingRate },
      { label: "fields", value: ctx.attrs?.fields?.join(", "), mono: true },
      { label: "endpoints", value: ctx.attrs?.endpoints?.length },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    DistributionUI,
    FunctionUI,
    CachePolicyUI,
    OriginRequestPolicyUI,
    ResponseHeadersPolicyUI,
    OriginAccessControlUI,
    PublicKeyUI,
    KeyGroupUI,
    KeyValueStoreUI,
    KvEntriesUI,
    KvRoutesUpdateUI,
    InvalidationUI,
    VpcOriginUI,
    RealtimeLogConfigUI,
  );
