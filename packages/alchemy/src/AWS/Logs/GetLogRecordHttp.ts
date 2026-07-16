import * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import type { Credentials } from "@distilled.cloud/aws/Credentials";
import type { Region } from "@distilled.cloud/aws/Region";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { makeLogsQueryHttpBinding } from "./BindingHttp.ts";
import { GetLogRecord } from "./GetLogRecord.ts";

export const GetLogRecordHttp = Layer.effect(
  GetLogRecord,
  // Explicit type args: the request has a required `logRecordPointer`; the
  // OperationMethod intersection defeats inference of `I` on its own.
  // Scoped by the record pointer from a query-result row — no logGroupName.
  makeLogsQueryHttpBinding<
    Logs.GetLogRecordRequest,
    Logs.GetLogRecordResponse,
    Logs.GetLogRecordError,
    Credentials | Region | HttpClient.HttpClient
  >({
    tag: "AWS.Logs.GetLogRecord",
    operation: Logs.getLogRecord,
    actions: ["logs:GetLogRecord"],
  }),
);
