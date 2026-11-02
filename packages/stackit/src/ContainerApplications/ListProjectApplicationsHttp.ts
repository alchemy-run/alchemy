import * as sca from "@distilled.cloud/stackit/sca";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding } from "./BindingHttp.ts";
import { ListProjectApplications } from "./ListProjectApplications.ts";

/**
 * HTTP implementation of {@link ListProjectApplications}.
 *
 * @layer
 * @provides Stackit.ContainerApplications.ListProjectApplications
 */
export const ListProjectApplicationsHttp = Layer.effect(
  ListProjectApplications,
  makeProjectHttpBinding({
    tag: "Stackit.ContainerApplications.ListProjectApplications",
    permissions: ["sca.application.list"],
    operation: sca.listProjectApplications,
  }),
);
