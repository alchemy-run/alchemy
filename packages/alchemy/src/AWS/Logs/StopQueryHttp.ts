import * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import type { Credentials } from "@distilled.cloud/aws/Credentials";
import type { Region } from "@distilled.cloud/aws/Region";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { makeLogGroupHttpBinding } from "./BindingHttp.ts";
import { StopQuery } from "./StopQuery.ts";

export const StopQueryHttp = Layer.effect(
  StopQuery,
  // Explicit type args: the request has a required `queryId`, so the compiler
  // must not fall back to the `{ logGroupName?: string }` constraint when
  // inferring `I` from the OperationMethod intersection.
  makeLogGroupHttpBinding<
    Logs.StopQueryRequest,
    Logs.StopQueryResponse,
    Logs.StopQueryError,
    Credentials | Region | HttpClient.HttpClient
  >({
    tag: "AWS.Logs.StopQuery",
    operation: Logs.stopQuery,
    actions: ["logs:StopQuery"],
    // logs:StopQuery does not support resource-level permissions — an
    // exact log-group-ARN statement never matches (verified via the IAM
    // policy simulator: allowed for StartQuery/GetQueryResults on the same
    // ARN, implicitDeny for StopQuery). Grant on `*`.
    iamResources: "all",
    // Scoped by the query id returned from StartQuery.
    injectLogGroupName: false,
  }),
);
