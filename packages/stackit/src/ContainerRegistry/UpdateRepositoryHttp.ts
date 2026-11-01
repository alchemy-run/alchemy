import * as harbor from "@distilled.cloud/stackit/registry_harbor";
import * as Layer from "effect/Layer";
import { makeHarborHttpBinding } from "./BindingHttp.ts";
import { UpdateRepository } from "./UpdateRepository.ts";

/**
 * HTTP implementation of {@link UpdateRepository}.
 *
 * @layer
 * @provides Stackit.ContainerRegistry.UpdateRepository
 */
export const UpdateRepositoryHttp = Layer.effect(
  UpdateRepository,
  makeHarborHttpBinding({
    tag: "Stackit.ContainerRegistry.UpdateRepository",
    operation: harbor.updateRepository,
  }),
);
