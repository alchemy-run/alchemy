import * as harbor from "@distilled.cloud/stackit/registry_harbor";
import * as Layer from "effect/Layer";
import { makeHarborHttpBinding } from "./BindingHttp.ts";
import { CreateTag } from "./CreateTag.ts";

/**
 * HTTP implementation of {@link CreateTag}.
 *
 * @layer
 * @provides Stackit.ContainerRegistry.CreateTag
 */
export const CreateTagHttp = Layer.effect(
  CreateTag,
  makeHarborHttpBinding({
    tag: "Stackit.ContainerRegistry.CreateTag",
    operation: harbor.createTag,
  }),
);
