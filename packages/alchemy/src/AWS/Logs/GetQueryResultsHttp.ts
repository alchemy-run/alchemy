import * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import type { Credentials } from "@distilled.cloud/aws/Credentials";
import type { Region } from "@distilled.cloud/aws/Region";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { makeLogGroupHttpBinding } from "./BindingHttp.ts";
import { GetQueryResults } from "./GetQueryResults.ts";

export const GetQueryResultsHttp = Layer.effect(
  GetQueryResults,
  // Explicit type args: the request has a required `queryId`, so the compiler
  // must not fall back to the `{ logGroupName?: string }` constraint when
  // inferring `I` from the OperationMethod intersection.
  makeLogGroupHttpBinding<
    Logs.GetQueryResultsRequest,
    Logs.GetQueryResultsResponse,
    Logs.GetQueryResultsError,
    Credentials | Region | HttpClient.HttpClient
  >({
    tag: "AWS.Logs.GetQueryResults",
    operation: Logs.getQueryResults,
    actions: ["logs:GetQueryResults"],
    // Scoped by the query id returned from StartQuery.
    injectLogGroupName: false,
  }),
);
