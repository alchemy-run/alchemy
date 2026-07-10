import type * as TSW from "@distilled.cloud/aws/timestream-write";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface WriteRecordsRequest extends Omit<
  TSW.WriteRecordsInput,
  "DatabaseName" | "TableName"
> {}

/** @binding */
export interface WriteRecords extends Binding.Service<
  WriteRecords,
  "AWS.Timestream.WriteRecords",
  (
    table: Table,
  ) => Effect.Effect<
    (
      request: WriteRecordsRequest,
    ) => Effect.Effect<
      TSW.WriteRecordsOutput,
      TSW.WriteRecordsError | TSW.DescribeEndpointsError
    >
  >
> {}

export const WriteRecords = Binding.Service<WriteRecords>(
  "AWS.Timestream.WriteRecords",
);
