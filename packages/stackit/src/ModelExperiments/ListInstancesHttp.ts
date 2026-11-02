import * as modelExperiments from "@distilled.cloud/stackit/model_experiments";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding } from "./BindingHttp.ts";
import { ListInstances } from "./ListInstances.ts";

/**
 * HTTP implementation of {@link ListInstances}.
 *
 * @layer
 * @provides Stackit.ModelExperiments.ListInstances
 */
export const ListInstancesHttp = Layer.effect(
  ListInstances,
  makeProjectHttpBinding({
    tag: "Stackit.ModelExperiments.ListInstances",
    permission: "model-experiments.instance.list",
    operation: modelExperiments.listInstances,
  }),
);
