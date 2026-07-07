import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface ScanRequest extends Omit<DynamoDB.ScanInput, "TableName"> {}

/** @binding */
export interface Scan extends Binding.Service<
  Scan,
  "AWS.DynamoDB.Scan",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: ScanRequest,
    ) => Effect.Effect<DynamoDB.ScanOutput, DynamoDB.ScanError>
  >
> {}

export const Scan = Binding.Service<Scan>("AWS.DynamoDB.Scan");
