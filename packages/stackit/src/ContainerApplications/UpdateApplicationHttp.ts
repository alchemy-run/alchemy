import * as sca from "@distilled.cloud/stackit/sca";
import * as Layer from "effect/Layer";
import { makeApplicationHttpBinding } from "./BindingHttp.ts";
import { UpdateApplication } from "./UpdateApplication.ts";

/**
 * HTTP implementation of {@link UpdateApplication}.
 *
 * @layer
 * @provides Stackit.ContainerApplications.UpdateApplication
 */
export const UpdateApplicationHttp = Layer.effect(
  UpdateApplication,
  makeApplicationHttpBinding({
    tag: "Stackit.ContainerApplications.UpdateApplication",
    permissions: ["sca.application.update"],
    operation: sca.updateApplication,
  }),
);
