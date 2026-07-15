import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { makeQAppsInstanceHttpBinding } from "./BindingHttp.ts";
import { PredictQApp } from "./PredictQApp.ts";

export const PredictQAppHttp = Layer.effect(
  PredictQApp,
  makeQAppsInstanceHttpBinding<
    qapps.PredictQAppInput,
    qapps.PredictQAppOutput,
    qapps.PredictQAppError
  >({
    capability: "PredictQApp",
    iamActions: ["qapps:PredictQApp"],
    operation: qapps.predictQApp,
  }),
);
