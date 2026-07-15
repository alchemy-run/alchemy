import * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as Layer from "effect/Layer";
import { makeDataExchangeAccountHttpBinding } from "./BindingHttp.ts";
import { StartJob } from "./StartJob.ts";

export const StartJobHttp = Layer.effect(
  StartJob,
  makeDataExchangeAccountHttpBinding({
    tag: "AWS.DataExchange.StartJob",
    operation: dataexchange.startJob,
    actions: ["dataexchange:StartJob"],
  }),
);
