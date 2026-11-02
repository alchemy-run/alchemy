import * as workflows from "@distilled.cloud/stackit/workflows";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { UpdateDagBundle } from "./UpdateDagBundle.ts";

/**
 * HTTP implementation of {@link UpdateDagBundle}.
 *
 * @layer
 * @provides Stackit.Workflows.UpdateDagBundle
 */
export const UpdateDagBundleHttp = Layer.effect(
  UpdateDagBundle,
  makeInstanceHttpBinding({
    tag: "Stackit.Workflows.UpdateDagBundle",
    permission: "workflows.dag-bundles.update",
    operation: workflows.updateDagBundle,
  }),
);
