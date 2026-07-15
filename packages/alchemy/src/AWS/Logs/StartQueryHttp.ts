import * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Layer from "effect/Layer";
import { makeLogGroupHttpBinding } from "./BindingHttp.ts";
import { StartQuery } from "./StartQuery.ts";

export const StartQueryHttp = Layer.effect(
  StartQuery,
  makeLogGroupHttpBinding({
    tag: "AWS.Logs.StartQuery",
    operation: Logs.startQuery,
    actions: ["logs:StartQuery", "logs:StopQuery"],
  }),
);
