import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { makeQAppsInstanceHttpBinding } from "./BindingHttp.ts";
import { BatchUpdateCategory } from "./BatchUpdateCategory.ts";

export const BatchUpdateCategoryHttp = Layer.effect(
  BatchUpdateCategory,
  makeQAppsInstanceHttpBinding<
    qapps.BatchUpdateCategoryInput,
    qapps.BatchUpdateCategoryResponse,
    qapps.BatchUpdateCategoryError
  >({
    capability: "BatchUpdateCategory",
    iamActions: ["qapps:BatchUpdateCategory"],
    operation: qapps.batchUpdateCategory,
  }),
);
