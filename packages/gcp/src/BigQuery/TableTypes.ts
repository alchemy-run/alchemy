import type * as bigquery from "@distilled.cloud/gcp/bigquery_v2";
import * as Data from "effect/Data";

/** A query job did not finish within the client's bounded wait. */
export class QueryNotComplete extends Data.TaggedError("GCP.BigQuery.QueryNotComplete")<{
  jobId: string | undefined;
}> {}

/** Per-row errors from a `tabledata.insertAll` request. */
export class InsertRowsFailed extends Data.TaggedError("GCP.BigQuery.InsertRowsFailed")<{
  insertErrors: ReadonlyArray<{
    /** Index of the rejected row in the request. */
    index: number | undefined;
    errors: ReadonlyArray<bigquery.ErrorProto>;
  }>;
}> {}
