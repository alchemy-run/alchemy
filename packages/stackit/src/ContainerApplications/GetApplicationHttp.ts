import * as sca from "@distilled.cloud/stackit/sca";
import * as Layer from "effect/Layer";
import { makeApplicationHttpBinding } from "./BindingHttp.ts";
import { GetApplication } from "./GetApplication.ts";

/**
 * HTTP implementation of {@link GetApplication}.
 *
 * @layer
 * @provides Stackit.ContainerApplications.GetApplication
 */
export const GetApplicationHttp = Layer.effect(
  GetApplication,
  makeApplicationHttpBinding({
    tag: "Stackit.ContainerApplications.GetApplication",
    permissions: ["sca.application.get"],
    operation: sca.getApplication,
  }),
);
