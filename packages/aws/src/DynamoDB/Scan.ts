import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeTableHttpBinding } from "./BindingHttp.ts";
import type { Table } from "./Table.ts";

export interface ScanRequest extends Omit<DynamoDB.ScanInput, "TableName"> {}

/**
 * Runtime binding for `dynamodb:Scan`.
 *
 * Bind this operation to a `Table` inside a function runtime to get a callable
 * that scans the full table, automatically injecting the table name. Provide
 * the `ScanHttp` layer on the Function to satisfy the binding.
 * ### Reading Data
 * **Example:** Scan a Table
 * ```typescript
 * const scan = yield* AWS.DynamoDB.Scan(table);
 *
 * const response = yield* scan({});
 * const items = response.Items;
 * const count = response.Count;
 * ```
 *
 * @binding
 */
export interface Scan extends Binding.Service<
  Scan,
  "AWS.DynamoDB.Scan",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (request: ScanRequest) => Effect.Effect<DynamoDB.ScanOutput, DynamoDB.ScanError>
  >
> {}

export const Scan = Binding.Service<Scan>("AWS.DynamoDB.Scan");

export const ScanHttp = Layer.effect(
  Scan,
  makeTableHttpBinding({
    tag: "AWS.DynamoDB.Scan",
    operation: DynamoDB.scan,
    actions: ["dynamodb:Scan"],
    resources: (table) => [table.tableArn, Output.interpolate`${table.tableArn}/index/*`],
  }),
);
