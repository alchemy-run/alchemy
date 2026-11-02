import * as sca from "@distilled.cloud/stackit/sca";
import * as Layer from "effect/Layer";
import { makeEnvironmentHttpBinding } from "./BindingHttp.ts";
import { ListEnvironmentRegistries } from "./ListEnvironmentRegistries.ts";

/**
 * HTTP implementation of {@link ListEnvironmentRegistries}.
 *
 * @layer
 * @provides Stackit.ContainerApplications.ListEnvironmentRegistries
 */
export const ListEnvironmentRegistriesHttp = Layer.effect(
  ListEnvironmentRegistries,
  makeEnvironmentHttpBinding({
    tag: "Stackit.ContainerApplications.ListEnvironmentRegistries",
    permissions: ["sca.environment.registry.list"],
    operation: sca.listEnvironmentRegistries,
  }),
);
