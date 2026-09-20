import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Stream } from "./Stream.ts";
import type { StreamConsumer } from "./StreamConsumer.ts";

/**
 * Dashboard UI providers for AWS Kinesis resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const regionOf = (arn: string | undefined) => arn?.split(":")[3];

export const StreamUI = UIProvider.succeed<Stream>("AWS.Kinesis.Stream", {
  displayName: "Kinesis Stream",
  icon: "waves",
  color: "#8C4FFF",
  category: "queue",
  summary: (ctx) => ctx.attrs?.streamName,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.streamArn);
    return ctx.attrs?.streamName === undefined || region === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/kinesis/home?region=${region}#/streams/details/${encodeURIComponent(ctx.attrs.streamName)}`;
  },
  facts: (ctx) => [
    { label: "stream", value: ctx.attrs?.streamName, copy: true },
    { label: "arn", value: ctx.attrs?.streamArn, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.streamStatus },
    { label: "mode", value: ctx.attrs?.streamMode },
    { label: "open shards", value: ctx.attrs?.openShardCount },
    { label: "retention (h)", value: ctx.attrs?.retentionPeriodHours },
    { label: "encryption", value: ctx.attrs?.encryptionType },
  ],
});

export const StreamConsumerUI = UIProvider.succeed<StreamConsumer>(
  "AWS.Kinesis.StreamConsumer",
  {
    displayName: "Kinesis Stream Consumer",
    icon: "download",
    color: "#8C4FFF",
    category: "queue",
    summary: (ctx) => ctx.attrs?.consumerName,
    facts: (ctx) => [
      { label: "consumer", value: ctx.attrs?.consumerName, copy: true },
      { label: "arn", value: ctx.attrs?.consumerArn, mono: true, copy: true },
      { label: "status", value: ctx.attrs?.consumerStatus },
      { label: "stream", value: ctx.attrs?.streamArn, mono: true, copy: true },
    ],
  },
);

export const ui = () => Layer.mergeAll(StreamUI, StreamConsumerUI);
