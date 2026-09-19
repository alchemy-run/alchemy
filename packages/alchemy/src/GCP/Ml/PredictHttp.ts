import * as ml from "@distilled.cloud/gcp/ml_v1";
import * as Layer from "effect/Layer";
import { makeModelHttpBinding } from "./BindingHttp.ts";
import { Predict } from "./Predict.ts";

/**
 * HTTP implementation of {@link Predict}.
 *
 * @layer
 * @provides GCP.Ml.Predict
 */
export const PredictHttp = Layer.effect(
  Predict,
  makeModelHttpBinding({
    tag: "GCP.Ml.Predict",
    operation: ml.predictProjects,
  }),
);
