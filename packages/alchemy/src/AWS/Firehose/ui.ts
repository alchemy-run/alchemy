import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { DeliveryStream } from "./DeliveryStream.ts";

/**
 * Dashboard UI providers for AWS Firehose resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const regionOf = (arn: string | undefined) => arn?.split(":")[3];

export const DeliveryStreamUI = UIProvider.succeed<DeliveryStream>(
  "AWS.Firehose.DeliveryStream",
  {
    displayName: "Firehose Delivery Stream",
    icon: "send",
    color: "#8C4FFF",
    category: "queue",
    summary: (ctx) => ctx.attrs?.deliveryStreamName,
    consoleUrl: (ctx) => {
      const region = regionOf(ctx.attrs?.deliveryStreamArn);
      return ctx.attrs?.deliveryStreamName === undefined || region === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/firehose/home?region=${region}#/details/${encodeURIComponent(ctx.attrs.deliveryStreamName)}`;
    },
    facts: (ctx) => [
      { label: "stream", value: ctx.attrs?.deliveryStreamName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.deliveryStreamArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.deliveryStreamStatus },
      { label: "source", value: ctx.attrs?.deliveryStreamType },
      { label: "bucket", value: ctx.attrs?.bucketArn, mono: true, copy: true },
      { label: "compression", value: ctx.attrs?.compressionFormat },
      { label: "encryption", value: ctx.attrs?.encryptionStatus },
    ],
  },
);

export const ui = () => Layer.mergeAll(DeliveryStreamUI);
