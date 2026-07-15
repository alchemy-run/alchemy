import * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Layer from "effect/Layer";
import { makeLogGroupHttpBinding } from "./BindingHttp.ts";
import { StopQuery } from "./StopQuery.ts";

export const StopQueryHttp = Layer.effect(
  StopQuery,
  makeLogGroupHttpBinding({
    tag: "AWS.Logs.StopQuery",
    operation: Logs.stopQuery,
    actions: ["logs:StopQuery"],
    // Scoped by the query id returned from StartQuery.
    injectLogGroupName: false,
  }),
);
