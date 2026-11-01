import * as sca from "@distilled.cloud/stackit/sca";
import * as Layer from "effect/Layer";
import { makeEnvironmentHttpBinding } from "./BindingHttp.ts";
import { ListApplications } from "./ListApplications.ts";

/**
 * HTTP implementation of {@link ListApplications}.
 *
 * @layer
 * @provides Stackit.ContainerApplications.ListApplications
 */
export const ListApplicationsHttp = Layer.effect(
  ListApplications,
  makeEnvironmentHttpBinding({
    tag: "Stackit.ContainerApplications.ListApplications",
    permissions: ["sca.application.list"],
    operation: sca.listApplications,
  }),
);
