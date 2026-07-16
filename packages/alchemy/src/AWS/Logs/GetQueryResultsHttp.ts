import * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import type { Credentials } from "@distilled.cloud/aws/Credentials";
import type { Region } from "@distilled.cloud/aws/Region";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { makeLogsQueryHttpBinding } from "./BindingHttp.ts";
import { GetQueryResults } from "./GetQueryResults.ts";

export const GetQueryResultsHttp = Layer.effect(
  GetQueryResults,
  // Explicit type args: the request has a required `queryId`; the
  // OperationMethod intersection defeats inference of `I` on its own.
  // Scoped by the query id returned from StartQuery — no logGroupName.
  makeLogsQueryHttpBinding<
    Logs.GetQueryResultsRequest,
    Logs.GetQueryResultsResponse,
    Logs.GetQueryResultsError,
    Credentials | Region | HttpClient.HttpClient
  >({
    tag: "AWS.Logs.GetQueryResults",
    operation: Logs.getQueryResults,
    actions: ["logs:GetQueryResults"],
  }),
);
