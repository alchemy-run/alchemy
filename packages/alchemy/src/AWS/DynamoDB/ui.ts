import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Table } from "./Table.ts";

/**
 * Dashboard UI providers for AWS DynamoDB resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** Extract the region segment from an AWS ARN (`arn:aws:dynamodb:REGION:...`). */
const regionOfArn = (arn: string | undefined): string | undefined =>
  arn?.split(":")[3] || undefined;

export const TableUI = UIProvider.succeed<Table>("AWS.DynamoDB.Table", {
  displayName: "DynamoDB Table",
  icon: "table",
  color: "#C925D1",
  category: "database",
  summary: (ctx) => ctx.attrs?.tableName,
  consoleUrl: (ctx) => {
    const region = regionOfArn(ctx.attrs?.tableArn);
    return region === undefined || ctx.attrs?.tableName === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/dynamodbv2/home?region=${region}#table?name=${ctx.attrs.tableName}`;
  },
  facts: (ctx) => [
    { label: "table", value: ctx.attrs?.tableName, copy: true },
    { label: "arn", value: ctx.attrs?.tableArn, mono: true, copy: true },
    {
      label: "key",
      value:
        ctx.attrs?.partitionKey === undefined
          ? undefined
          : `${ctx.attrs.partitionKey}${ctx.attrs.sortKey ? ` / ${ctx.attrs.sortKey}` : ""}`,
      mono: true,
    },
    { label: "billing", value: ctx.props?.billingMode },
    {
      label: "stream",
      value: ctx.attrs?.latestStreamArn,
      mono: true,
      copy: true,
    },
    { label: "gsis", value: ctx.attrs?.globalSecondaryIndexes?.length },
    { label: "lsis", value: ctx.attrs?.localSecondaryIndexes?.length },
    {
      label: "pitr",
      value:
        ctx.attrs?.pointInTimeRecoveryDescription?.PointInTimeRecoveryStatus,
    },
  ],
});

export const ui = () => Layer.mergeAll(TableUI);
