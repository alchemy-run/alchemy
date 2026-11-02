import * as harbor from "@distilled.cloud/stackit/registry_harbor";
import * as Layer from "effect/Layer";
import { makeHarborHttpBinding } from "./BindingHttp.ts";
import { DeleteTag } from "./DeleteTag.ts";

/**
 * HTTP implementation of {@link DeleteTag}.
 *
 * @layer
 * @provides Stackit.ContainerRegistry.DeleteTag
 */
export const DeleteTagHttp = Layer.effect(
  DeleteTag,
  makeHarborHttpBinding({
    tag: "Stackit.ContainerRegistry.DeleteTag",
    operation: harbor.deleteTag,
  }),
);
