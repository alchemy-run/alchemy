import type * as TSQ from "@distilled.cloud/aws/timestream-query";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface QueryRequest extends TSQ.QueryRequest {}

/** @binding */
export interface Query extends Binding.Service<
  Query,
  "AWS.Timestream.Query",
  (
    table: Table,
  ) => Effect.Effect<
    (
      request: QueryRequest,
    ) => Effect.Effect<
      TSQ.QueryResponse,
      TSQ.QueryError | TSQ.DescribeEndpointsError
    >
  >
> {}

export const Query = Binding.Service<Query>("AWS.Timestream.Query");
