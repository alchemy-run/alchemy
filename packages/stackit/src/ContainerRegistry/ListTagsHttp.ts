import * as harbor from "@distilled.cloud/stackit/registry_harbor";
import * as Layer from "effect/Layer";
import { makeHarborHttpBinding } from "./BindingHttp.ts";
import { ListTags } from "./ListTags.ts";

/**
 * HTTP implementation of {@link ListTags}.
 *
 * @layer
 * @provides Stackit.ContainerRegistry.ListTags
 */
export const ListTagsHttp = Layer.effect(
  ListTags,
  makeHarborHttpBinding({
    tag: "Stackit.ContainerRegistry.ListTags",
    operation: harbor.listTags,
  }),
);
