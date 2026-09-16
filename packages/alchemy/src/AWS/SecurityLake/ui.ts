import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AwsLogSource } from "./AwsLogSource.ts";
import type { CustomLogSource } from "./CustomLogSource.ts";
import type { DataLake } from "./DataLake.ts";
import type { ExceptionSubscription } from "./ExceptionSubscription.ts";
import type { Subscriber } from "./Subscriber.ts";
import type { SubscriberNotification } from "./SubscriberNotification.ts";

/**
 * Dashboard UI providers for AWS SecurityLake resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const AwsLogSourceUI = UIProvider.succeed<AwsLogSource>(
  "AWS.SecurityLake.AwsLogSource",
  {
    displayName: "Security Lake AWS Log Source",
    icon: "cloud",
    color: "#DD344C",
    category: "security",
    summary: (ctx) => ctx.attrs?.sourceName,
    facts: (ctx) => [
      { label: "source", value: ctx.attrs?.sourceName, copy: true },
      { label: "version", value: ctx.attrs?.sourceVersion },
      { label: "regions", value: ctx.attrs?.regions?.join(", ") },
      { label: "accounts", value: ctx.attrs?.accounts?.length },
    ],
  },
);

export const CustomLogSourceUI = UIProvider.succeed<CustomLogSource>(
  "AWS.SecurityLake.CustomLogSource",
  {
    displayName: "Security Lake Custom Log Source",
    icon: "plug",
    color: "#DD344C",
    category: "security",
    summary: (ctx) => ctx.attrs?.sourceName,
    facts: (ctx) => [
      { label: "source", value: ctx.attrs?.sourceName, copy: true },
      { label: "version", value: ctx.attrs?.sourceVersion },
      { label: "crawler", value: ctx.attrs?.crawlerArn, mono: true },
      { label: "database", value: ctx.attrs?.databaseArn, mono: true },
      { label: "table", value: ctx.attrs?.tableArn, mono: true },
      { label: "provider role", value: ctx.attrs?.providerRoleArn, mono: true },
    ],
  },
);

export const DataLakeUI = UIProvider.succeed<DataLake>(
  "AWS.SecurityLake.DataLake",
  {
    displayName: "Security Lake Data Lake",
    icon: "database",
    color: "#DD344C",
    category: "security",
    summary: (ctx) => ctx.attrs?.regions?.join(", "),
    facts: (ctx) => [
      { label: "arn", value: ctx.attrs?.dataLakeArn, mono: true, copy: true },
      { label: "regions", value: ctx.attrs?.regions?.join(", ") },
      {
        label: "status",
        value: ctx.attrs?.dataLakes?.[0]?.createStatus,
      },
      {
        label: "metastore role",
        value: ctx.props?.metaStoreManagerRoleArn,
        mono: true,
      },
    ],
  },
);

export const ExceptionSubscriptionUI =
  UIProvider.succeed<ExceptionSubscription>(
    "AWS.SecurityLake.ExceptionSubscription",
    {
      displayName: "Security Lake Exception Subscription",
      icon: "alert-triangle",
      color: "#DD344C",
      category: "security",
      summary: (ctx) => ctx.attrs?.notificationEndpoint,
      facts: (ctx) => [
        { label: "protocol", value: ctx.attrs?.subscriptionProtocol },
        {
          label: "endpoint",
          value: ctx.attrs?.notificationEndpoint,
          copy: true,
        },
        { label: "ttl (days)", value: ctx.attrs?.exceptionTimeToLive },
      ],
    },
  );

export const SubscriberUI = UIProvider.succeed<Subscriber>(
  "AWS.SecurityLake.Subscriber",
  {
    displayName: "Security Lake Subscriber",
    icon: "user",
    color: "#DD344C",
    category: "security",
    summary: (ctx) => ctx.attrs?.subscriberName,
    facts: (ctx) => [
      { label: "subscriber", value: ctx.attrs?.subscriberName, copy: true },
      {
        label: "id",
        value: ctx.attrs?.subscriberId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.subscriberArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.subscriberStatus },
      { label: "role", value: ctx.attrs?.roleArn, mono: true },
      { label: "endpoint", value: ctx.attrs?.subscriberEndpoint, mono: true },
    ],
  },
);

export const SubscriberNotificationUI =
  UIProvider.succeed<SubscriberNotification>(
    "AWS.SecurityLake.SubscriberNotification",
    {
      displayName: "Security Lake Subscriber Notification",
      icon: "bell",
      color: "#DD344C",
      category: "security",
      summary: (ctx) =>
        ctx.attrs?.subscriberEndpoint ?? ctx.attrs?.subscriberId,
      facts: (ctx) => [
        {
          label: "subscriber",
          value: ctx.attrs?.subscriberId,
          mono: true,
          copy: true,
        },
        {
          label: "endpoint",
          value: ctx.attrs?.subscriberEndpoint,
          mono: true,
          copy: true,
        },
      ],
    },
  );

export const ui = () =>
  Layer.mergeAll(
    AwsLogSourceUI,
    CustomLogSourceUI,
    DataLakeUI,
    ExceptionSubscriptionUI,
    SubscriberUI,
    SubscriberNotificationUI,
  );
