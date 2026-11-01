import * as harbor from "@distilled.cloud/stackit/registry_harbor";
import * as Layer from "effect/Layer";
import { makeHarborHttpBinding } from "./BindingHttp.ts";
import { GetRepository } from "./GetRepository.ts";

/**
 * HTTP implementation of {@link GetRepository}.
 *
 * @layer
 * @provides Stackit.ContainerRegistry.GetRepository
 */
export const GetRepositoryHttp = Layer.effect(
  GetRepository,
  makeHarborHttpBinding({
    tag: "Stackit.ContainerRegistry.GetRepository",
    operation: harbor.getRepository,
  }),
);
