import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Queue } from "./Queue.ts";

/**
 * Dashboard UI providers for AWS SQS resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const regionOf = (arn: string | undefined) => arn?.split(":")[3];

export const QueueUI = UIProvider.succeed<Queue>("AWS.SQS.Queue", {
  displayName: "SQS Queue",
  icon: "list-ordered",
  color: "#E7157B",
  category: "queue",
  summary: (ctx) => ctx.attrs?.queueName,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.queueArn);
    return ctx.attrs?.queueUrl === undefined || region === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/sqs/v3/home?region=${region}#/queues/${encodeURIComponent(ctx.attrs.queueUrl)}`;
  },
  facts: (ctx) => [
    { label: "queue", value: ctx.attrs?.queueName, copy: true },
    { label: "arn", value: ctx.attrs?.queueArn, mono: true, copy: true },
    { label: "url", value: ctx.attrs?.queueUrl, mono: true, copy: true },
    { label: "fifo", value: ctx.props?.fifo },
    { label: "visibility timeout", value: ctx.props?.visibilityTimeout },
    { label: "retention", value: ctx.props?.messageRetentionPeriod },
  ],
});

export const ui = () => Layer.mergeAll(QueueUI);
