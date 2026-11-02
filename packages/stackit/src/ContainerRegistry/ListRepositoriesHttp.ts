import * as harbor from "@distilled.cloud/stackit/registry_harbor";
import * as Layer from "effect/Layer";
import { makeHarborHttpBinding } from "./BindingHttp.ts";
import { ListRepositories } from "./ListRepositories.ts";

/**
 * HTTP implementation of {@link ListRepositories}.
 *
 * @layer
 * @provides Stackit.ContainerRegistry.ListRepositories
 */
export const ListRepositoriesHttp = Layer.effect(
  ListRepositories,
  makeHarborHttpBinding({
    tag: "Stackit.ContainerRegistry.ListRepositories",
    operation: harbor.listRepositories,
  }),
);
