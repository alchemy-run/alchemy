import * as workflows from "@distilled.cloud/stackit/workflows";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetDagBundle } from "./GetDagBundle.ts";

/**
 * HTTP implementation of {@link GetDagBundle}.
 *
 * @layer
 * @provides Stackit.Workflows.GetDagBundle
 */
export const GetDagBundleHttp = Layer.effect(
  GetDagBundle,
  makeInstanceHttpBinding({
    tag: "Stackit.Workflows.GetDagBundle",
    permission: "workflows.dag-bundles.get",
    operation: workflows.getDagBundle,
  }),
);
