import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Bucket } from "./Bucket.ts";
import type { BucketEventNotification } from "./BucketEventNotification.ts";
import type { BucketSippy } from "./BucketSippy.ts";
import type { DataCatalog } from "./DataCatalog.ts";

/**
 * Dashboard UI providers for Cloudflare R2 resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const BucketUI = UIProvider.succeed<Bucket>("Cloudflare.R2.Bucket", {
  displayName: "R2 Bucket",
  icon: "hard-drive",
  color: "#F6821F",
  category: "storage",
  summary: (ctx) => ctx.attrs?.bucketName,
  consoleUrl: (ctx) =>
    ctx.attrs?.accountId === undefined || ctx.attrs.bucketName === undefined
      ? undefined
      : `https://dash.cloudflare.com/${ctx.attrs.accountId}/r2/default/buckets/${ctx.attrs.bucketName}`,
  facts: (ctx) => [
    { label: "bucket", value: ctx.attrs?.bucketName, mono: true, copy: true },
    { label: "storage class", value: ctx.attrs?.storageClass },
    { label: "jurisdiction", value: ctx.attrs?.jurisdiction },
    { label: "location", value: ctx.attrs?.location },
    {
      label: "domains",
      value: ctx.attrs?.domains?.length
        ? ctx.attrs.domains.map((d) => d.domain).join(", ")
        : undefined,
    },
    {
      label: "lifecycle rules",
      value: ctx.attrs?.lifecycleRules?.length || undefined,
    },
    { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
  ],
});

export const BucketSippyUI = UIProvider.succeed<BucketSippy>(
  "Cloudflare.R2.BucketSippy",
  {
    displayName: "R2 Sippy",
    icon: "arrow-right-left",
    color: "#F6821F",
    category: "storage",
    summary: (ctx) => ctx.attrs?.bucketName,
    facts: (ctx) => [
      { label: "bucket", value: ctx.attrs?.bucketName, mono: true, copy: true },
      { label: "enabled", value: ctx.attrs?.enabled },
      { label: "source provider", value: ctx.attrs?.source?.provider },
      { label: "source bucket", value: ctx.attrs?.source?.bucket, mono: true },
      { label: "source region", value: ctx.attrs?.source?.region },
      { label: "jurisdiction", value: ctx.attrs?.jurisdiction },
      { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
    ],
  },
);

export const BucketEventNotificationUI =
  UIProvider.succeed<BucketEventNotification>(
    "Cloudflare.R2.BucketEventNotification",
    {
      displayName: "R2 Event Notification",
      icon: "bell",
      color: "#F6821F",
      category: "eventing",
      summary: (ctx) => ctx.attrs?.bucketName,
      facts: (ctx) => [
        {
          label: "bucket",
          value: ctx.attrs?.bucketName,
          mono: true,
          copy: true,
        },
        { label: "queue", value: ctx.attrs?.queueName },
        {
          label: "queue id",
          value: ctx.attrs?.queueId,
          mono: true,
          copy: true,
        },
        { label: "rules", value: ctx.attrs?.rules?.length },
        { label: "jurisdiction", value: ctx.attrs?.jurisdiction },
        {
          label: "account",
          value: ctx.attrs?.accountId,
          mono: true,
          copy: true,
        },
      ],
    },
  );

export const DataCatalogUI = UIProvider.succeed<DataCatalog>(
  "Cloudflare.R2.DataCatalog",
  {
    displayName: "R2 Data Catalog",
    icon: "table",
    color: "#F6821F",
    category: "database",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "warehouse", value: ctx.attrs?.name, mono: true, copy: true },
      {
        label: "catalog id",
        value: ctx.attrs?.catalogId,
        mono: true,
        copy: true,
      },
      { label: "bucket", value: ctx.attrs?.bucketName, mono: true },
      { label: "status", value: ctx.attrs?.status },
      {
        label: "catalog uri",
        value: ctx.attrs?.catalogUri,
        mono: true,
        copy: true,
      },
      { label: "credential", value: ctx.attrs?.credentialStatus },
      { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    BucketUI,
    BucketSippyUI,
    BucketEventNotificationUI,
    DataCatalogUI,
  );
