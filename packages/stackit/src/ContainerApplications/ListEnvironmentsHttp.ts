import * as sca from "@distilled.cloud/stackit/sca";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding } from "./BindingHttp.ts";
import { ListEnvironments } from "./ListEnvironments.ts";

/**
 * HTTP implementation of {@link ListEnvironments}.
 *
 * @layer
 * @provides Stackit.ContainerApplications.ListEnvironments
 */
export const ListEnvironmentsHttp = Layer.effect(
  ListEnvironments,
  makeProjectHttpBinding({
    tag: "Stackit.ContainerApplications.ListEnvironments",
    permissions: ["sca.environment.list"],
    operation: sca.listEnvironments,
  }),
);
