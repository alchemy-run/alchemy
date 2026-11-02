import * as workflows from "@distilled.cloud/stackit/workflows";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListDagBundles } from "./ListDagBundles.ts";

/**
 * HTTP implementation of {@link ListDagBundles}.
 *
 * @layer
 * @provides Stackit.Workflows.ListDagBundles
 */
export const ListDagBundlesHttp = Layer.effect(
  ListDagBundles,
  makeInstanceHttpBinding({
    tag: "Stackit.Workflows.ListDagBundles",
    permission: "workflows.dag-bundles.list",
    operation: workflows.listDagBundles,
  }),
);
