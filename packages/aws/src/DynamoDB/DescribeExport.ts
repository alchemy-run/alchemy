import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeTableIamHttpBinding } from "./BindingHttp.ts";
import type { Table } from "./Table.ts";

export interface DescribeExportRequest extends DynamoDB.DescribeExportInput {}

/**
 * Runtime binding for `dynamodb:DescribeExport`.
 *
 * Bind this operation to a `Table` inside a function runtime to get a callable
 * that reads the status of one of the bound table's S3 exports by ARN. The
 * IAM grant covers every export of the bound table (`{tableArn}/export/*`).
 * Provide the `DescribeExportHttp` layer on the Function to satisfy the
 * binding.
 * ### Exporting to S3
 * **Example:** Poll an Export Until It Completes
 * ```typescript
 * const describeExport = yield* AWS.DynamoDB.DescribeExport(table);
 *
 * const response = yield* describeExport({ ExportArn: exportArn });
 * const status = response.ExportDescription?.ExportStatus;
 * ```
 *
 * @binding
 */
export interface DescribeExport extends Binding.Service<
  DescribeExport,
  "AWS.DynamoDB.DescribeExport",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: DescribeExportRequest,
    ) => Effect.Effect<DynamoDB.DescribeExportOutput, DynamoDB.DescribeExportError>
  >
> {}
export const DescribeExport = Binding.Service<DescribeExport>("AWS.DynamoDB.DescribeExport");

export const DescribeExportHttp = Layer.effect(
  DescribeExport,
  makeTableIamHttpBinding({
    tag: "AWS.DynamoDB.DescribeExport",
    operation: DynamoDB.describeExport,
    actions: ["dynamodb:DescribeExport"],
    resources: (table) => [Output.interpolate`${table.tableArn}/export/*`],
  }),
);
