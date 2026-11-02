import * as harbor from "@distilled.cloud/stackit/registry_harbor";
import * as Layer from "effect/Layer";
import { makeHarborHttpBinding } from "./BindingHttp.ts";
import { DeleteRepository } from "./DeleteRepository.ts";

/**
 * HTTP implementation of {@link DeleteRepository}.
 *
 * @layer
 * @provides Stackit.ContainerRegistry.DeleteRepository
 */
export const DeleteRepositoryHttp = Layer.effect(
  DeleteRepository,
  makeHarborHttpBinding({
    tag: "Stackit.ContainerRegistry.DeleteRepository",
    operation: harbor.deleteRepository,
  }),
);
